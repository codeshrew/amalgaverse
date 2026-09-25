#!/bin/zsh
# Runs on your Mac (launchd, see scripts/install-local-sync.sh). It does the part
# GitHub Actions can't do without an Anthropic key: cataloguing new beats and
# writing the vote readouts using your local `claude` login. It commits only
# data/*.json; the push re-deploys the Pages site.
set -euo pipefail
export PATH="$HOME/.local/share/fnm/aliases/default/bin:$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
cd "${0:A:h}/.."
echo "== $(date) local sync"
git pull --rebase --autostash -q
node scripts/update.mjs
if ! git diff --quiet -- data/; then
  git add data/
  git commit -qm "Catalogue beats and refresh vote readouts (local sync)"
  git pull --rebase -q && git push -q
  echo "pushed data changes"
fi
