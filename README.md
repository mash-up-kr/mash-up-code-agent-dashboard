# Mash-Up Code Agent Dashboard

## How to Start

### Claude Code 훅 설정

Claude Code가 세션 이벤트를 대시보드로 전송하려면 훅을 등록해야 합니다.

`~/.claude/settings.json` 에 아래 내용을 추가합니다.
`/절대경로/` 는 이 프로젝트 루트의 실제 경로로 교체합니다 (`pwd` 로 확인).

```json
{
  "hooks": {
    "PreToolUse": [{"matcher": "", "hooks": [{"type": "command", "command": "/절대경로/hook-handler.sh PreToolUse"}]}],
    "PostToolUse": [{"matcher": "", "hooks": [{"type": "command", "command": "/절대경로/hook-handler.sh PostToolUse"}]}],
    "PermissionRequest": [{"matcher": "", "hooks": [{"type": "command", "command": "/절대경로/hook-handler.sh PermissionRequest"}]}],
    "Stop": [{"matcher": "", "hooks": [{"type": "command", "command": "/절대경로/hook-handler.sh Stop"}]}],
    "PreCompact": [{"matcher": "", "hooks": [{"type": "command", "command": "/절대경로/hook-handler.sh PreCompact"}]}],
    "PostCompact": [{"matcher": "", "hooks": [{"type": "command", "command": "/절대경로/hook-handler.sh PostCompact"}]}],
    "StatusLine": [{"matcher": "", "hooks": [{"type": "command", "command": "/절대경로/hook-handler.sh StatusLine"}]}]
  }
}
```

설정 후 Claude Code를 재시작해야 적용됩니다.
