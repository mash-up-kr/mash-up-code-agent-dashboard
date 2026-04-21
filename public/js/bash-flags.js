/* ══════════════════════════════════════════════════
   Bash flag dictionary (Korean descriptions)
   Looked up by parseBashTokens to render hover tooltips.
   Two layers:
     FLAG_DICT[cmd][flag]                    — command-level flags
     SUBCOMMAND_DICT["cmd sub"][flag]        — overrides for subcommands
   ══════════════════════════════════════════════════ */
window.FLAG_DICT = {
  ls: {
    '-l': '긴 포맷 (권한/크기/시간 포함)',
    '-a': '숨김 파일 포함',
    '-h': '사람이 읽기 쉬운 크기 (K/M/G)',
    '-t': '수정 시간순 정렬',
    '-S': '크기순 정렬',
    '-r': '역순',
    '-R': '재귀적으로 하위 디렉토리',
    '-1': '한 줄에 하나씩',
    '-d': '디렉토리 자체만 (내용 X)',
  },
  grep: {
    '-i': '대소문자 무시',
    '-v': '일치하지 않는 라인만',
    '-r': '재귀 검색',
    '-R': '재귀 검색 (심볼릭 링크 따라감)',
    '-l': '매치된 파일명만 출력',
    '-L': '매치 안 된 파일명',
    '-n': '라인 번호 표시',
    '-c': '매치 라인 수만',
    '-E': '확장 정규식 (+,?,|,())',
    '-F': '고정 문자열 (정규식 해석 X)',
    '-A': '매치 후 N줄 추가',
    '-B': '매치 전 N줄 추가',
    '-C': '매치 전후 N줄 (context)',
    '-o': '매치 부분만 출력',
    '-w': '단어 경계 매치',
    '-q': '조용히 (매치되면 exit 0)',
    '--include': '검색할 파일 패턴',
    '--exclude': '제외할 파일 패턴',
    '--exclude-dir': '제외할 디렉토리',
  },
  find: {
    '-name': '이름 매치 (글로브)',
    '-iname': '이름 매치 (대소문자 무시)',
    '-type': '파일 타입 (f=파일, d=디렉토리, l=심볼릭)',
    '-exec': '매치에 명령 실행 ({} 로 치환)',
    '-mtime': '수정 일수 (+7=7일전보다 오래)',
    '-mmin': '수정 분수',
    '-size': '파일 크기 (+1M=1MB보다 큰)',
    '-maxdepth': '검색 최대 깊이',
    '-mindepth': '검색 최소 깊이',
    '-prune': '가지치기 (해당 디렉토리 건너뜀)',
    '-not': '부정',
    '-empty': '빈 파일/디렉토리',
    '-delete': '매치 삭제 (위험)',
    '-path': '전체 경로 매치',
  },
  git: {
    '--oneline': '커밋당 한 줄로',
    '--graph': 'ASCII 브랜치 그래프',
    '--decorate': '참조 이름(브랜치/태그) 표시',
    '--all': '모든 브랜치',
    '--stat': '파일별 변경 통계',
    '-p': 'patch (diff) 형식',
    '-S': 'pickaxe: 추가/제거된 문자열 검색',
    '-G': 'pickaxe: 정규식',
    '-n': 'N개만',
    '--name-only': '변경된 파일 이름만',
    '--name-status': '파일 이름 + 상태 (A/M/D)',
    '-a': '추적 파일 모두 스테이징',
    '-m': '커밋 메시지',
    '-M': 'rename 감지',
    '-b': '새 브랜치 생성 & 이동',
    '-d': '브랜치 삭제 (merged만)',
    '-D': '강제 브랜치 삭제',
    '-f': '강제 실행',
    '--force': '강제 실행',
    '--force-with-lease': '안전한 강제 푸시',
    '--amend': '직전 커밋 수정',
    '--no-verify': 'pre-commit hook 건너뜀 (주의)',
    '--cached': '인덱스(스테이징) 대상',
    '--staged': '스테이징된 변경 대상',
    '--hard': '작업 트리까지 리셋 (위험)',
    '--soft': 'HEAD만 이동',
    '--mixed': '인덱스까지 리셋 (기본)',
    '-i': '인터랙티브 모드',
    '--continue': '중단된 작업 이어서',
    '--abort': '중단',
    '--rebase': 'merge 대신 rebase',
    '-u': 'upstream 설정 (push -u)',
    '-v': '상세 출력',
    '--dry-run': '실제 실행 안 함',
  },
  npm: {
    '-g': '전역 설치',
    '-D': 'devDependencies에 추가',
    '--save-dev': 'devDependencies에 추가',
    '--save': 'dependencies에 추가 (기본)',
    '-S': 'dependencies에 추가 (기본)',
    '-f': 'force',
    '--legacy-peer-deps': 'peer 의존성 관대하게',
    '--production': '개발 의존성 제외',
    '-y': '모든 질문에 yes',
    '--workspace': '특정 workspace 대상',
    '--ws': '모든 workspaces 대상',
  },
  docker: {
    '-t': '태그 이름',
    '-p': '포트 매핑 host:container',
    '-v': '볼륨 마운트 host:container',
    '-e': '환경 변수',
    '-d': '백그라운드(detached) 실행',
    '--rm': '종료 시 컨테이너 자동 삭제',
    '-it': '인터랙티브 + TTY',
    '-i': '인터랙티브',
    '--name': '컨테이너 이름',
    '-f': 'Dockerfile 경로 (build) / 강제 (rm)',
    '--network': '네트워크 지정',
    '--restart': '재시작 정책',
  },
  kubectl: {
    '-n': '네임스페이스',
    '-o': '출력 형식 (yaml/json/wide)',
    '-f': '파일에서 리소스 정의',
    '--all-namespaces': '모든 네임스페이스',
    '-A': '모든 네임스페이스 (short)',
    '-l': '라벨 셀렉터',
    '--dry-run': '실제 적용 안 함',
    '-w': 'watch 모드',
    '--follow': '로그 계속 추적',
  },
  curl: {
    '-X': 'HTTP 메소드 (GET/POST/...)',
    '-H': '요청 헤더',
    '-d': 'POST 바디 데이터',
    '--data-raw': '가공 없이 그대로 바디',
    '-o': '파일로 저장',
    '-O': '원본 이름으로 저장',
    '-L': '리다이렉트 따라감',
    '-s': '조용히 (진행률 숨김)',
    '-S': '조용해도 에러는 표시',
    '-v': 'verbose (상세)',
    '-i': '응답 헤더 포함',
    '-I': 'HEAD 요청',
    '-k': 'SSL 검증 건너뜀',
    '-u': '인증 user:pass',
    '--compressed': 'gzip/deflate 해독',
  },
  wget: {
    '-O': '출력 파일명',
    '-c': '이어받기 (resume)',
    '-r': '재귀',
    '-q': '조용히',
    '-nc': '이미 있으면 안 받음',
  },
  head: {
    '-n': 'N줄만 (또는 -N)',
    '-c': 'N바이트만',
  },
  tail: {
    '-n': 'N줄만',
    '-f': '파일 계속 추적 (follow)',
    '-F': '파일 재생성까지 추적',
    '-c': 'N바이트만',
  },
  sort: {
    '-n': '숫자 정렬',
    '-r': '역순',
    '-u': '중복 제거',
    '-k': '지정 키(컬럼)로 정렬',
    '-t': '필드 구분자',
    '-h': 'human-readable 크기 (1K, 2M)',
    '-V': '버전 정렬',
  },
  uniq: {
    '-c': '카운트 포함',
    '-d': '중복만 출력',
    '-u': '유니크만 출력',
    '-i': '대소문자 무시',
  },
  wc: {
    '-l': '줄 수',
    '-w': '단어 수',
    '-c': '바이트 수',
    '-m': '문자 수',
  },
  xargs: {
    '-I': '치환 기호 (예: -I{})',
    '-n': 'N개씩 전달',
    '-P': '병렬 N개',
    '-0': 'null 구분자 (find -print0과 짝)',
    '-r': '입력 비면 실행 안 함',
  },
  tar: {
    '-c': '아카이브 생성',
    '-x': '아카이브 추출',
    '-t': '내용 목록 보기',
    '-v': '상세 (파일 목록)',
    '-z': 'gzip (.tar.gz)',
    '-j': 'bzip2 (.tar.bz2)',
    '-J': 'xz (.tar.xz)',
    '-f': '파일 지정 (필수)',
    '-C': '디렉토리로 이동해서 작업',
  },
  chmod: {
    '-R': '재귀',
    '-v': '변경 내용 표시',
  },
  sed: {
    '-i': '파일 직접 편집 (in-place)',
    '-e': '표현식 실행',
    '-n': '조용히 (p 명령어로만 출력)',
    '-E': '확장 정규식',
    '-r': '확장 정규식 (GNU)',
  },
  awk: {
    '-F': '필드 구분자',
    '-v': '변수 지정 (-v name=val)',
    '-f': '스크립트 파일',
  },
  make: {
    '-j': '병렬 빌드 (N개)',
    '-f': 'Makefile 지정',
    '-C': '디렉토리 이동 후 실행',
    '-B': '무조건 다시 빌드',
    '-n': 'dry-run (실행 안 함)',
  },
  ssh: {
    '-i': '키 파일',
    '-p': '포트',
    '-L': '로컬 포트 포워딩',
    '-R': '원격 포트 포워딩',
    '-N': '명령 실행 안 함 (터널만)',
    '-f': '백그라운드',
    '-v': '디버그',
  },
  rsync: {
    '-a': '아카이브 모드 (-rlptgoD)',
    '-v': '상세',
    '-z': '압축 전송',
    '-n': 'dry-run',
    '-P': '진행률 + 부분 전송',
    '--delete': '수신 측에서 빠진 파일 삭제',
    '--exclude': '제외 패턴',
  },
  ps: {
    '-a': '다른 사용자 프로세스도',
    '-u': '사용자 포함 포맷',
    '-x': '터미널 없는 프로세스도',
    '-e': '모든 프로세스',
    '-f': '전체 포맷',
  },
  ln: {
    '-s': '심볼릭 링크',
    '-f': '기존 링크 덮어쓰기',
  },
  rm: {
    '-r': '재귀 (디렉토리)',
    '-R': '재귀 (디렉토리)',
    '-f': '강제 (확인 없음)',
    '-i': '확인 프롬프트',
  },
  cp: {
    '-r': '재귀 (디렉토리)',
    '-R': '재귀 (디렉토리)',
    '-p': '권한/시간 보존',
    '-a': '아카이브 (=-dR --preserve=all)',
    '-n': '덮어쓰기 안 함',
    '-i': '덮어쓰기 확인',
  },
  mv: {
    '-i': '덮어쓰기 확인',
    '-n': '덮어쓰기 안 함',
    '-f': '강제',
  },
  mkdir: {
    '-p': '중간 디렉토리도 생성',
    '-m': '권한 지정',
  },
};

/* Subcommand-specific flag meanings (overrides FLAG_DICT) */
window.SUBCOMMAND_DICT = {
  'git log': {
    '-p': 'patch diff 표시',
    '--graph': 'ASCII 브랜치 그래프',
    '--oneline': '커밋당 한 줄',
    '-S': 'pickaxe: 특정 문자열 추가/제거된 커밋',
    '-G': 'pickaxe: 정규식',
    '--follow': '파일 이름 바뀌어도 추적',
    '--since': '이후 커밋만',
    '--until': '이전 커밋만',
    '--author': '저자 필터',
    '--grep': '메시지 필터',
    '-n': 'N개만',
  },
  'git diff': {
    '--cached': '스테이징된 변경 (= --staged)',
    '--staged': '스테이징된 변경',
    '--stat': '파일별 요약',
    '--name-only': '파일명만',
    '-w': '공백 변경 무시',
    '-U': 'context 줄 수 (-U0 = context 없음)',
  },
  'git reset': {
    '--hard': '작업 트리까지 리셋 (위험: 변경 사라짐)',
    '--soft': 'HEAD만 이동 (변경은 스테이징에 남음)',
    '--mixed': '인덱스까지 리셋 (기본)',
  },
  'git rebase': {
    '-i': '인터랙티브 리베이스',
    '--continue': '충돌 해결 후 계속',
    '--abort': '리베이스 취소',
    '--onto': '특정 커밋 위로 옮기기',
  },
  'git checkout': {
    '-b': '새 브랜치 생성 & 체크아웃',
    '-B': '강제 생성 (있으면 리셋)',
    '--': '경로 구분자 (이후는 파일)',
  },
  'git push': {
    '-u': 'upstream 설정',
    '--force-with-lease': '안전한 강제 푸시',
    '--tags': '태그도 푸시',
    '--dry-run': '실제 푸시 안 함',
  },
  'git stash': {
    '-u': '추적 안 되는 파일도 stash',
    'pop': '최근 stash 적용 & 삭제',
    'apply': '최근 stash 적용 (삭제 X)',
    'drop': '특정 stash 삭제',
  },
  'docker run': {
    '-d': '백그라운드 실행',
    '--rm': '종료 시 자동 삭제',
    '-it': '인터랙티브 + TTY',
  },
  'docker build': {
    '-t': '이미지 태그',
    '-f': 'Dockerfile 경로',
    '--no-cache': '캐시 안 씀',
  },
  'kubectl get': {
    '-o': '출력 형식',
    '-w': 'watch',
    '--show-labels': '라벨 표시',
  },
  'kubectl logs': {
    '-f': '계속 추적',
    '-c': '컨테이너 지정',
    '--tail': '마지막 N줄',
    '--since': '이후 로그만',
    '-p': '이전 컨테이너 로그',
  },
};

/* Lookup helper — returns a Korean description for (cmd, subcmd, flag) or null. */
window.lookupFlag = function(cmd, subcmd, flag) {
  if (!cmd || !flag) return null;
  // Strip =value from --flag=value
  const eqIdx = flag.indexOf('=');
  const flagKey = eqIdx >= 0 ? flag.slice(0, eqIdx) : flag;
  if (subcmd) {
    const key = cmd + ' ' + subcmd;
    const sub = window.SUBCOMMAND_DICT[key];
    if (sub && sub[flagKey]) return sub[flagKey];
  }
  const top = window.FLAG_DICT[cmd];
  if (top && top[flagKey]) return top[flagKey];
  // Combined short flags like -la → split into -l + -a
  if (/^-[a-zA-Z]{2,}$/.test(flagKey) && top) {
    const parts = flagKey.slice(1).split('').map(ch => {
      const desc = top['-' + ch];
      return desc ? ('-' + ch + ': ' + desc) : null;
    }).filter(Boolean);
    if (parts.length > 0) return parts.join('\n');
  }
  return null;
};
