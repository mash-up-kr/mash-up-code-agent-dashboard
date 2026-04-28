#!/bin/bash
# Usage:
#   ./start.sh                  start server (로컬 의존성 자동 설치) + open browser
#   ./start.sh --community      커뮤니티 의존성까지 포함해 시작
#   ./start.sh install          로컬 의존성만 설치 (서버 미기동)
#   ./start.sh install:community 커뮤니티까지 포함해 설치 (서버 미기동)
#   ./start.sh stop             kill server
#   ./start.sh status           check running state

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${AGENT_VIZ_PORT:-4321}"

cd "$DIR"

ensure_node() {
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo "node/npm이 필요해요." >&2
    exit 1
  fi
}

install_local() {
  ensure_node
  echo "[deps] 로컬 의존성 설치 중…"
  npm install --omit=optional --silent
}

install_community() {
  ensure_node
  echo "[deps] 커뮤니티 포함 전체 의존성 설치 중…"
  npm install --include=optional --silent
}

needs_local()     { [ ! -d "$DIR/node_modules/express" ]; }
needs_community() { [ ! -d "$DIR/node_modules/mysql2" ]; }

launch_server() {
  local label="${1:-}"
  if lsof -ti:$PORT >/dev/null 2>&1; then
    echo "already running  →  http://localhost:$PORT"
  else
    nohup node "$DIR/server.js" >> /tmp/agent-viz-simple.log 2>&1 &
    sleep 1
    echo "started  →  http://localhost:$PORT${label:+ ($label)}"
  fi
  open "http://localhost:$PORT" 2>/dev/null || xdg-open "http://localhost:$PORT" 2>/dev/null || true
}

case "${1:-}" in
  install)            install_local ;;
  install:community)  install_community ;;
  stop)
    if lsof -ti:$PORT >/dev/null 2>&1; then
      kill $(lsof -ti:$PORT) 2>/dev/null
      echo "stopped (port $PORT)"
    else
      echo "not running"
    fi
    ;;
  status)
    if lsof -ti:$PORT >/dev/null 2>&1; then
      echo "running  →  http://localhost:$PORT"
    else
      echo "stopped"
    fi
    ;;
  --community)
    if needs_local || needs_community; then install_community; fi
    launch_server "커뮤니티 활성"
    ;;
  *)
    if needs_local; then install_local; fi
    launch_server
    ;;
esac
