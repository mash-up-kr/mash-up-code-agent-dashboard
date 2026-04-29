# Community Feature Spec

## Scope

이 문서는 커뮤니티 기능 중 채팅을 제외한 범위를 정의한다.

포함 범위:
- 회원가입, 로그인, 로그아웃
- Claude 연동 토큰 발급 및 로컬 `.env.local` 자동 설정 명령
- 그룹 생성, 그룹 참여, 그룹 목록 조회, 그룹 나가기
- 그룹 대시보드의 멤버 활동 현황
- Claude 훅 메트릭 수신 및 그룹별 실시간 라우팅

제외 범위:
- 그룹 채팅 메시지 송수신
- 채팅 unread badge
- 로컬 전용 작업실/사용량 탭

## 서비스 구성

커뮤니티 기능은 백엔드 서버와 로컬 대시보드가 분리될 수 있다.

- 로컬 대시보드: 사용자가 보는 UI, 작업실/사용량 탭 포함
- 커뮤니티 백엔드: 인증, 그룹, 멤버 활동 메트릭 API 제공
- MySQL: 회원, 그룹, 그룹 멤버, 이벤트 로그 저장
- Claude 훅: 사용자의 로컬 Claude 이벤트를 커뮤니티 백엔드로 전송

배포 환경에서는 `server.community.js`가 커뮤니티 백엔드만 실행한다. 로컬 개발 환경에서는 기존 `server.js`가 전체 대시보드를 실행한다.

## 사용자 인증 플로우

### 회원가입

1. 사용자가 회원가입 모달에서 아이디, 비밀번호, 이름을 입력한다.
2. 프론트는 `POST /api/auth/register`를 호출한다.
3. 서버는 아이디 중복을 확인한다.
4. 서버는 비밀번호를 bcrypt로 해시한다.
5. 서버는 사용자별 `hook_token`을 생성한다.
6. `members` 테이블에 사용자 정보를 저장한다.
7. 서버는 세션에 `memberId`, `username`, `name`을 저장한다.
8. 프론트는 회원가입 완료 후 Claude 연동 토큰 모달을 표시한다.

회원가입 응답에는 최초 연동 안내를 위해 `hookToken`이 포함된다.

### 로그인

1. 사용자가 로그인 모달에서 아이디와 비밀번호를 입력한다.
2. 프론트는 `POST /api/auth/login`을 호출한다.
3. 서버는 아이디로 사용자를 조회한다.
4. bcrypt로 비밀번호를 검증한다.
5. 검증에 성공하면 세션에 사용자 정보를 저장한다.
6. 프론트는 그룹 목록을 갱신한다.

로그인은 presence 이벤트가 아니다. 멤버의 온라인 상태는 그룹 대시보드 SSE 연결과 Claude 훅 이벤트를 통해 반영된다.

### 로그아웃

1. 사용자가 로그아웃을 누른다.
2. 프론트는 `POST /api/auth/logout`을 호출한다.
3. 서버는 해당 사용자의 채팅/커뮤니티 SSE 연결을 정리한다.
4. 서버는 세션을 파기한다.
5. 프론트는 커뮤니티 상태를 초기화하고 로그인 모달을 표시한다.

## Claude 연동 플로우

### 목적

Claude 훅 이벤트는 브라우저 세션과 분리되어 실행된다. 따라서 서버가 훅 이벤트를 어떤 사용자에게 귀속할지 알기 위해 사용자별 `COMMUNITY_HOOK_TOKEN`이 필요하다.

### 토큰 발급

1. 로그인 사용자가 설정 메뉴에서 Claude 토큰 보기를 누른다.
2. 프론트는 `GET /api/metrics/token`을 호출한다.
3. 서버는 현재 로그인 사용자의 `hook_token`을 조회한다.
4. 토큰이 없으면 새로 생성해서 `members.hook_token`에 저장한다.
5. 프론트는 토큰과 자동 설정 명령을 모달에 표시한다.

### `.env.local` 자동 설정 명령

토큰 모달은 다음 형태의 명령을 생성한다.

```bash
curl -fsSL <community-api-url>/api/metrics/env-installer | sh -s -- '<hook-token>' '<community-api-url>'
```

사용자는 Claude를 실행하는 로컬 프로젝트 루트에서 이 명령을 실행한다.

설치 스크립트 동작:
- 현재 디렉터리의 `.env.local` 파일을 생성하거나 갱신한다.
- `COMMUNITY_HOOK_TOKEN=<hook-token>`을 저장한다.
- `COMMUNITY_API_URL=<community-api-url>`을 저장한다.
- 같은 키가 이미 있으면 기존 줄을 교체한다.
- 같은 키가 여러 줄 있으면 하나만 남긴다.

이 명령은 훅 설정 파일을 수정하지 않는다. 이미 설치된 `hook-handler.sh`가 `.env.local`을 읽어 커뮤니티 서버로 이벤트를 보낸다는 전제다.

## 그룹 생성 플로우

1. 로그인 사용자가 그룹 생성 버튼을 누른다.
2. 사용자는 그룹 이름과 그룹 내 닉네임을 입력한다.
3. 프론트는 `POST /api/community/groups`를 호출한다.
4. 서버는 8자리 초대 코드를 생성한다.
5. 서버는 `groups`에 그룹을 생성한다.
6. 서버는 생성자를 `group_members`에 추가하고 `is_creator = 1`로 저장한다.
7. 서버는 트랜잭션을 커밋한다.
8. 프론트는 생성 완료 화면에서 초대 코드를 보여준다.
9. 사용자는 생성 직후 그룹에 입장할 수 있다.

그룹 정원 기본값은 20명이다.

## 그룹 참여 플로우

1. 로그인 사용자가 그룹 참여 버튼을 누른다.
2. 사용자는 초대 코드와 그룹 내 닉네임을 입력한다.
3. 프론트는 `GET /api/community/groups/verify?code=...`로 그룹을 미리 조회한다.
4. 서버는 코드에 해당하는 그룹과 현재 멤버 수를 반환한다.
5. 프론트는 그룹명과 정원 정보를 확인 화면에 표시한다.
6. 사용자가 참여를 확정하면 `POST /api/community/groups/join`을 호출한다.
7. 서버는 초대 코드가 유효한지 확인한다.
8. 서버는 정원이 초과되었는지 확인한다.
9. 서버는 이미 참여 중인지 확인한다.
10. 서버는 `group_members`에 사용자를 추가한다.
11. 프론트는 그룹 목록을 갱신하고 해당 그룹 화면으로 이동한다.

## 그룹 목록 플로우

1. 커뮤니티 탭 진입 시 로그인 상태를 확인한다.
2. 로그인되어 있지 않으면 인증 필요 화면을 표시한다.
3. 로그인되어 있으면 `GET /api/community/groups`를 호출한다.
4. 서버는 현재 사용자가 참여 중인 그룹만 조회한다.
5. 프론트는 그룹 카드 목록을 렌더링한다.

그룹 카드에는 다음 정보가 표시된다.
- 그룹 이름
- 초대 코드
- 현재 멤버 수 / 최대 멤버 수
- 생성자 여부
- 그룹 입장 버튼
- 그룹 나가기 메뉴

## 그룹 나가기 플로우

1. 사용자가 그룹 카드 메뉴에서 나가기를 선택한다.
2. 프론트는 확인 다이얼로그를 표시한다.
3. 사용자가 확정하면 `DELETE /api/community/groups/:groupId/leave`를 호출한다.
4. 서버는 사용자가 해당 그룹 멤버인지 확인한다.
5. 서버는 `group_members`에서 사용자를 제거한다.
6. 그룹 멤버가 0명이 되면 `groups` 레코드도 삭제한다.
7. 프론트는 그룹 목록을 갱신한다.

## 그룹 대시보드 플로우

### 그룹 입장

1. 사용자가 그룹 카드의 입장 버튼을 누른다.
2. 프론트는 그룹 목록 화면을 숨기고 그룹 대시보드 화면을 표시한다.
3. 프론트는 `GET /api/metrics/groups/:groupId/sse`로 SSE 연결을 연다.
4. 서버는 요청자가 해당 그룹 멤버인지 확인한다.
5. 멤버가 아니면 403을 반환한다.
6. 멤버이면 SSE 연결을 등록하고 현재 멤버 활동 스냅샷을 전송한다.

### 멤버 카드

그룹 대시보드는 그룹 멤버별 카드를 표시한다.

멤버 카드 주요 정보:
- 닉네임
- 온라인/활동 상태
- 최근 60분 토큰 사용 스파크라인
- Tool Calls 수
- Active Sessions 수
- 현재 활성 프로젝트 목록

현재 로그인한 사용자는 목록 앞쪽에 정렬된다.

### 온라인 및 활성 세션 기준

서버는 메모리의 `memberMetrics`를 기준으로 상태를 계산한다.

- 온라인 기준: 마지막 활동 시각이 5분 이내
- 활성 세션 기준: 세션별 마지막 이벤트 시각이 5분 이내
- 활성 프로젝트: 활성 세션의 `cwd` 마지막 경로명
- 카드 차트: 활성 세션의 최근 60분 토큰 버킷만 표시

세션이 오프라인 처리되면 활성 세션 수와 활성 프로젝트가 줄어들고, 카드 차트에서도 해당 세션 그래프가 사라진다.

### 멤버 상세 모달

멤버 카드를 클릭하면 상세 모달을 연다.

상세 모달은 `GET /api/metrics/members/:memberId/stats`를 호출한다.

상세 모달 주요 정보:
- 멤버 닉네임
- 최근 이벤트 기준 프로젝트명과 "현재 작업 중.." 표시
- 상태 배지
- Tool Calls
- Sessions
- Last Active
- 프로젝트별 최근 60분 토큰 흐름
- Recent Token Events

상세 모달의 차트는 카드와 달리 최근 60분 기록을 보여준다. 따라서 세션이 비활성화되어도 최근 이벤트 기록은 일정 시간 남을 수 있다.

## Claude 훅 메트릭 수신 플로우

1. 로컬 `hook-handler.sh`가 Claude 훅 이벤트를 받는다.
2. `.env.local`에서 `COMMUNITY_HOOK_TOKEN`과 `COMMUNITY_API_URL`을 읽는다.
3. 훅 핸들러는 `POST /api/metrics`로 이벤트를 전송한다.
4. 서버는 Authorization Bearer 토큰으로 사용자를 찾는다.
5. 서버는 사용자의 메모리 메트릭을 갱신한다.
6. `PostToolUse` 이벤트는 Tool Calls를 증가시킨다.
7. `Stop` 이벤트는 `input_tokens + output_tokens`를 합산해 토큰 사용량으로 기록한다.
8. 서버는 해당 사용자가 참여 중인 그룹 목록을 조회한다.
9. 서버는 각 그룹의 SSE 구독자에게 갱신된 멤버 활동 스냅샷을 전송한다.

훅 이벤트는 사용자가 참여 중인 그룹에만 브로드캐스트된다.

## 데이터 모델

### members

사용자 계정 정보와 Claude 훅 토큰을 저장한다.

주요 필드:
- `id`
- `username`
- `password_hash`
- `name`
- `hook_token`
- `created_at`

### groups

커뮤니티 그룹 정보를 저장한다.

주요 필드:
- `id`
- `name`
- `code`
- `max_members`
- `created_at`

### group_members

그룹과 사용자 간 참여 관계를 저장한다.

주요 필드:
- `id`
- `group_id`
- `member_id`
- `nickname`
- `is_creator`
- `joined_at`

### member_events

Claude 훅 이벤트 중 일부를 로그성 데이터로 저장한다.

저장 대상:
- `PostToolUse`
- `Stop`

주요 필드:
- `member_id`
- `session_id`
- `hook_event`
- `tool_name`
- `cwd`
- `project_name`
- `created_at`

## API Summary

### Auth

- `GET /api/auth/me`: 현재 로그인 사용자 조회
- `POST /api/auth/register`: 회원가입
- `POST /api/auth/login`: 로그인
- `POST /api/auth/logout`: 로그아웃

### Community

- `GET /api/community/groups`: 내가 참여 중인 그룹 목록
- `POST /api/community/groups`: 그룹 생성
- `GET /api/community/groups/verify?code=...`: 초대 코드 확인
- `POST /api/community/groups/join`: 그룹 참여
- `DELETE /api/community/groups/:groupId/leave`: 그룹 나가기

### Metrics

- `GET /api/metrics/token`: 내 Claude 훅 토큰 조회 또는 생성
- `GET /api/metrics/env-installer`: `.env.local` 자동 설정 스크립트
- `POST /api/metrics`: Claude 훅 이벤트 수신
- `GET /api/metrics/groups/:groupId/sse`: 그룹 멤버 활동 SSE
- `GET /api/metrics/groups/:groupId/members`: 그룹 멤버 활동 REST fallback
- `GET /api/metrics/members/:memberId/stats`: 멤버 상세 활동 조회

## 보안 및 접근 제어

- 인증은 `express-session` 기반 쿠키 세션으로 처리한다.
- 그룹 목록은 현재 사용자가 참여 중인 그룹만 반환한다.
- 그룹 SSE는 요청자가 해당 그룹 멤버일 때만 연결된다.
- 훅 이벤트는 `Authorization: Bearer <hook_token>`으로 인증한다.
- 훅 이벤트로 갱신된 데이터는 해당 사용자가 참여 중인 그룹에만 브로드캐스트한다.
- `.env.local` 자동 설정 스크립트는 토큰 파일만 갱신하며 훅 설정 파일은 변경하지 않는다.

## 운영 모드

### 로컬 전체 대시보드

`server.js`를 실행한다.

제공 기능:
- 로컬 작업실
- 사용량 탭
- 커뮤니티 UI
- 커뮤니티 API

### 배포 커뮤니티 백엔드

`server.community.js`를 실행한다.

제공 기능:
- 인증 API
- 그룹 API
- 메트릭 API
- 커뮤니티/그룹 대시보드용 SSE

제외 기능:
- 로컬 작업실
- 사용량 탭
- 정적 프론트 UI
