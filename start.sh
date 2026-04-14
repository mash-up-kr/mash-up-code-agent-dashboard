#!/bin/bash
# Usage:
#   ./start.sh         start server + open browser
#   ./start.sh stop    kill server
#   ./start.sh status  check running state

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${AGENT_VIZ_PORT:-4321}"

case "${1:-}" in
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
  *)
    if lsof -ti:$PORT >/dev/null 2>&1; then
      echo "already running  →  http://localhost:$PORT"
      open "http://localhost:$PORT" 2>/dev/null || xdg-open "http://localhost:$PORT" 2>/dev/null
    else
      nohup node "$DIR/server.js" >> /tmp/agent-viz-simple.log 2>&1 &
      sleep 1
      echo "started  →  http://localhost:$PORT"
      open "http://localhost:$PORT" 2>/dev/null || xdg-open "http://localhost:$PORT" 2>/dev/null
    fi
    ;;
esac