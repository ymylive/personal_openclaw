#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo 'usage: qq_openwebsearch.sh <query> [limit]' >&2
  exit 1
fi

QUERY="$1"
LIMIT="${2:-5}"
export PATH="/home/node/.local/node_modules/.bin:$PATH"
export MODE=stdio
export DEFAULT_SEARCH_ENGINE=duckduckgo
export ALLOWED_SEARCH_ENGINES=duckduckgo,bing,baidu,github,juejin,csdn

exec mcporter call --output json --stdio open-websearch search "query=${QUERY}" "limit:=${LIMIT}"
