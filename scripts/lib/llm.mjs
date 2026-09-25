// Tiny wrapper around the local `claude` CLI in headless mode (uses whatever
// login the machine already has). Every call is cached on disk by prompt hash,
// so re-running the updater is free unless the input changed.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const CACHE_DIR = new URL('../../.cache/llm/', import.meta.url).pathname;

// Backend: the local `claude` CLI (uses your Claude login) if installed, otherwise the
// Anthropic API when ANTHROPIC_API_KEY is set (e.g. in GitHub Actions).
const API_MODELS = { haiku: 'claude-haiku-4-5-20251001', sonnet: 'claude-sonnet-5' };
let backend;
function getBackend() {
  if (backend === undefined) {
    if (process.argv.includes('--no-llm') || process.env.AMALGA_NO_LLM) backend = null;
    else if (spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0) backend = 'cli';
    else if (process.env.ANTHROPIC_API_KEY) backend = 'api';
    else backend = null;
  }
  return backend;
}
export const llmAvailable = () => getBackend() !== null;

async function viaApi(prompt, model) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: API_MODELS[model] || model, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  return j.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  if (start < 0) throw new Error('no JSON in model output');
  const open = candidate[start];
  const close = open === '{' ? '}' : ']';
  const end = candidate.lastIndexOf(close);
  return JSON.parse(candidate.slice(start, end + 1));
}

/** Ask Claude for JSON. Returns parsed object. Throws on failure. */
export async function askJson(prompt, { model = 'haiku', timeoutMs = 240_000 } = {}) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const key = createHash('sha256').update(model + '\n' + prompt).digest('hex').slice(0, 24);
  const file = join(CACHE_DIR, key + '.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));

  if (getBackend() === 'api') {
    const parsed = extractJson(await viaApi(prompt, model));
    writeFileSync(file, JSON.stringify(parsed));
    return parsed;
  }

  const out = await new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--model', model, '--tools', '', '--output-format', 'json'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: CACHE_DIR, // keep project CLAUDE.md etc. out of the context
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('claude timed out'));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 300)}`));
      resolve(stdout);
    });
    child.stdin.end(prompt);
  });

  const envelope = JSON.parse(out);
  if (envelope.is_error) throw new Error(`claude error: ${String(envelope.result).slice(0, 300)}`);
  const parsed = extractJson(envelope.result);
  writeFileSync(file, JSON.stringify(parsed));
  return parsed;
}
