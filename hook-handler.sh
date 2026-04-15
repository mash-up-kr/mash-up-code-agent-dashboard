#!/bin/bash
# Claude Code Hook Handler — sends events to the viz server
# Usage: hook-handler.sh <event_type>
#   PreToolUse        → pre_tool_use       (before permission check)
#   PostToolUse       → tool_use           (after execution)
#   PermissionRequest → permission_request (waiting for user approval)
#   Stop              → stop               (Claude finished responding)
#   PreCompact        → pre_compact        (before compaction)
#   PostCompact       → post_compact       (after compaction)
#   Others            → passed through as-is
PORT="${AGENT_VIZ_PORT:-4321}"
EVENT_TYPE="${1:-unknown}"

SESSION_CWD="$(pwd 2>/dev/null || echo '')"
SESSION_NAME="$(basename "$SESSION_CWD" 2>/dev/null || echo 'unknown')"

if [ -n "$CLAUDE_SESSION_NAME" ]; then
  SESSION_NAME="$CLAUDE_SESSION_NAME"
fi

INPUT=$(cat 2>/dev/null || echo '{}')

# Extract Claude session_id from hook stdin — use as stable unique session identifier
SID=$(echo "$INPUT" | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4)
SESSION_ID="${SID:-unknown}"

PAYLOAD="{\"event\":\"$EVENT_TYPE\",\"session\":{\"pid\":\"$SESSION_ID\",\"cwd\":\"$SESSION_CWD\",\"name\":\"$SESSION_NAME\",\"sid\":\"$SID\"},\"data\":$INPUT}"

if [ "$EVENT_TYPE" = "session_start" ]; then
  # Retry up to 5 times to handle server startup delay
  for i in 1 2 3 4 5; do
    CODE=$(curl -s -m 1 -o /dev/null -w "%{http_code}" -X POST "http://localhost:$PORT/api/events" \
      -H 'Content-Type: application/json' -d "$PAYLOAD" 2>/dev/null)
    [ "$CODE" = "200" ] && exit 0
    sleep 1
  done
else
  curl -s -m 3 -X POST "http://localhost:$PORT/api/events" \
    -H 'Content-Type: application/json' -d "$PAYLOAD" \
    >/dev/null 2>&1 || true
fi