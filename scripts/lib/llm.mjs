// Tiny wrapper around the local `claude` CLI in headless mode (uses whatever
// login the machine already has). Every call is cached on disk by prompt hash,
// so re-running the updater is free unless the input changed.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const CACHE_DIR = new URL('../../.cache/llm/', import.meta.url).pathname;

let available;
export function llmAvailable() {
  if (available === undefined) {
    if (process.argv.includes('--no-llm') || process.env.AMALGA_NO_LLM) return (available = false);
    const r = spawnSync('claude', ['--version'], { encoding: 'utf8' });
    available = r.status === 0;
  }
  return available;
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
