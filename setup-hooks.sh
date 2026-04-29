#!/bin/bash
# Mash-Up Code Agent Dashboard — hook installer
#
# Usage:
#   ./setup-hooks.sh              install/update hooks in ~/.claude/settings.json
#   ./setup-hooks.sh --user       same (default scope)
#   ./setup-hooks.sh --project    install into ./.claude/settings.json
#   ./setup-hooks.sh --uninstall  remove hooks added by this installer
#   ./setup-hooks.sh --print      print the merged config without writing
#
# 동작:
#   - hook-handler.sh의 절대경로를 자동 감지
#   - 기존 settings.json은 .bak 으로 백업 후 머지 (다른 훅은 보존)
#   - 우리가 등록하는 훅 엔트리는 "command"에 hook-handler.sh 절대경로가 포함된 항목만 갱신/삭제
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK_HANDLER="$DIR/hook-handler.sh"

SCOPE="user"
MODE="install"

for arg in "$@"; do
  case "$arg" in
    --user)      SCOPE="user" ;;
    --project)   SCOPE="project" ;;
    --uninstall) MODE="uninstall" ;;
    --print)     MODE="print" ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "알 수 없는 옵션: $arg" >&2
      exit 2
      ;;
  esac
done

if [ ! -x "$HOOK_HANDLER" ]; then
  if [ -f "$HOOK_HANDLER" ]; then
    chmod +x "$HOOK_HANDLER"
  else
    echo "hook-handler.sh를 찾을 수 없어요: $HOOK_HANDLER" >&2
    exit 1
  fi
fi

if [ "$SCOPE" = "project" ]; then
  TARGET_DIR=".claude"
else
  TARGET_DIR="$HOME/.claude"
fi
TARGET="$TARGET_DIR/settings.json"

mkdir -p "$TARGET_DIR"
[ -f "$TARGET" ] || echo '{}' > "$TARGET"

if ! command -v node >/dev/null 2>&1; then
  echo "node가 필요해요 (JSON 머지에 사용)." >&2
  exit 1
fi

HOOK_HANDLER="$HOOK_HANDLER" TARGET="$TARGET" MODE="$MODE" node <<'NODE'
const fs   = require('fs');
const path = require('path');

const TARGET       = process.env.TARGET;
const HOOK_HANDLER = process.env.HOOK_HANDLER;
const MODE         = process.env.MODE;

const DESIRED = [
  { event: 'SessionStart', matcher: null, arg: 'session_start' },
  { event: 'SessionEnd',   matcher: null, arg: 'session_end' },
  { event: 'PreToolUse',   matcher: '*',  arg: 'PreToolUse' },
  { event: 'PostToolUse',  matcher: '*',  arg: 'PostToolUse' },
  { event: 'Notification', matcher: null, arg: 'PermissionRequest' },
  { event: 'Stop',         matcher: null, arg: 'Stop' },
  { event: 'PreCompact',   matcher: null, arg: 'PreCompact' },
  { event: 'StatusLine',   matcher: null, arg: 'StatusLine' },
];

const cmdFor = (arg) => `${HOOK_HANDLER} ${arg}`;
const isOurs = (cmd) => typeof cmd === 'string' && cmd.includes(HOOK_HANDLER);

// bash 측에서 TARGET 존재를 보장하므로 읽기 실패는 그대로 throw
const raw = fs.readFileSync(TARGET, 'utf8');
let cfg;
try { cfg = raw.trim() ? JSON.parse(raw) : {}; }
catch (e) {
  console.error(`설정 파일이 올바른 JSON이 아니에요: ${TARGET}\n  → ${e.message}`);
  process.exit(1);
}
if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) cfg = {};
if (!cfg.hooks || typeof cfg.hooks !== 'object') cfg.hooks = {};

const stripOurs = (eventName) => {
  const list = cfg.hooks[eventName];
  if (!Array.isArray(list)) return;
  const filtered = list
    .map(group => {
      if (!group || !Array.isArray(group.hooks)) return group;
      const hooks = group.hooks.filter(h => !(h && h.type === 'command' && isOurs(h.command)));
      return { ...group, hooks };
    })
    .filter(group => group && Array.isArray(group.hooks) && group.hooks.length > 0);
  if (filtered.length > 0) cfg.hooks[eventName] = filtered;
  else delete cfg.hooks[eventName];
};

// 다른 이벤트명에 잘못 등록된 우리 훅도 함께 정리
for (const event of Object.keys(cfg.hooks)) stripOurs(event);

if (MODE === 'uninstall') {
  if (Object.keys(cfg.hooks).length === 0) delete cfg.hooks;
} else {
  for (const d of DESIRED) {
    const list = cfg.hooks[d.event] || [];
    const group = d.matcher ? { matcher: d.matcher, hooks: [] } : { hooks: [] };
    group.hooks.push({ type: 'command', command: cmdFor(d.arg) });
    list.push(group);
    cfg.hooks[d.event] = list;
  }
}

const serialized = JSON.stringify(cfg, null, 2) + '\n';

if (MODE === 'print') {
  process.stdout.write(serialized);
  process.exit(0);
}

const backup = TARGET + '.bak';
fs.copyFileSync(TARGET, backup);
console.log(`백업: ${backup}`);
fs.writeFileSync(TARGET, serialized);
console.log(`${MODE === 'uninstall' ? '훅 제거 완료' : '훅 설치 완료'}: ${TARGET}`);
if (MODE !== 'uninstall') {
  console.log('등록된 훅:');
  for (const d of DESIRED) console.log(`  - ${d.event}${d.matcher ? ` (matcher: ${d.matcher})` : ''}`);
}
NODE
