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
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Hook subprocesses do not inherit dotenv values from the Node server,
# so load local env files here as well when present.
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  . "$SCRIPT_DIR/.env"
  set +a
fi
if [ -f "$SCRIPT_DIR/.env.local" ]; then
  set -a
  . "$SCRIPT_DIR/.env.local"
  set +a
fi

PORT="${AGENT_VIZ_PORT:-4321}"
COMMUNITY_API_URL="${COMMUNITY_API_URL:-http://localhost:$PORT}"
EVENT_TYPE="${1:-unknown}"

SESSION_CWD="$(pwd 2>/dev/null || echo '')"
SESSION_NAME="$(basename "$SESSION_CWD" 2>/dev/null || echo 'unknown')"

if [ -n "$CLAUDE_SESSION_NAME" ]; then
  SESSION_NAME="$CLAUDE_SESSION_NAME"
fi

INPUT=$(cat 2>/dev/null || echo '{}')

# Convert Claude Code PascalCase hook names to server-expected snake_case event names
case "$EVENT_TYPE" in
  PreToolUse)        EVENT_TYPE="pre_tool_use" ;;
  PostToolUse)       EVENT_TYPE="tool_use" ;;
  PermissionRequest) EVENT_TYPE="permission_request" ;;
  Stop)              EVENT_TYPE="stop" ;;
  PreCompact)        EVENT_TYPE="pre_compact" ;;
  PostCompact)       EVENT_TYPE="post_compact" ;;
  StatusLine)        EVENT_TYPE="statusline_update" ;;
esac

# Extract Claude session_id from hook stdin — tolerate JSON spacing differences
SID=$(printf '%s' "$INPUT" \
  | grep -Eo '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -1 \
  | sed -E 's/^"session_id"[[:space:]]*:[[:space:]]*"([^"]*)"$/\1/')

PAYLOAD="{\"event\":\"$EVENT_TYPE\",\"session\":{\"pid\":\"$SID\",\"cwd\":\"$SESSION_CWD\",\"name\":\"$SESSION_NAME\",\"sid\":\"$SID\"},\"data\":$INPUT}"

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

# 커뮤니티 서버로 전송 (COMMUNITY_HOOK_TOKEN 설정 시)
if [ -n "$COMMUNITY_HOOK_TOKEN" ]; then
  OUTPUT_TOKENS=0
  INPUT_TOKENS=0
  # Stop 훅 stdin에는 토큰 데이터가 없어 transcript_path의 JSONL 마지막 항목에서 읽어옴
  if [ "$1" = "Stop" ]; then
    TRANSCRIPT=$(printf '%s' "$INPUT" \
      | grep -Eo '"transcript_path"[[:space:]]*:[[:space:]]*"[^"]*"' \
      | head -1 \
      | sed -E 's/^"transcript_path"[[:space:]]*:[[:space:]]*"([^"]*)"$/\1/')
    if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
      LAST_USAGE=$(tail -n 30 "$TRANSCRIPT" | grep '"output_tokens"' | tail -1)
      OUTPUT_TOKENS=$(printf '%s' "$LAST_USAGE" \
        | grep -Eo '"output_tokens"[[:space:]]*:[[:space:]]*[0-9]+' \
        | head -1 | grep -Eo '[0-9]+$' || echo '0')
      INPUT_TOKENS=$(printf '%s' "$LAST_USAGE" \
        | grep -Eo '"input_tokens"[[:space:]]*:[[:space:]]*[0-9]+' \
        | head -1 | grep -Eo '[0-9]+$' || echo '0')
    fi
  fi
  COMMUNITY_PAYLOAD="{\"hook_event_name\":\"$1\",\"tool_name\":\"${TOOL_NAME:-}\",\"cwd\":\"$SESSION_CWD\",\"session_id\":\"$SID\",\"output_tokens\":${OUTPUT_TOKENS:-0},\"input_tokens\":${INPUT_TOKENS:-0}}"
  curl -s -m 3 -X POST "$COMMUNITY_API_URL/api/metrics" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $COMMUNITY_HOOK_TOKEN" \
    -d "$COMMUNITY_PAYLOAD" \
    >/dev/null 2>&1 || true
fi
