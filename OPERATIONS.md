# 운영 가이드 (OPERATIONS)

> 이 문서는 **운영 담당 AI 세션용 인수인계 문서**다. 설계·제작은 완료됐고,
> 운영 작업은 복잡한 추론이 필요 없으므로 **Sonnet 또는 Haiku급 모델로 충분**하다.
> 구조 변경(스키마, 파이프라인 로직, 새 인프라)은 운영 범위가 아님 — 사용자에게 확인 후 진행.

## 시스템 한 줄 요약

GitHub Actions가 매주 월 09:00 KST에 `scripts/collect.mjs` 실행 →
뉴스 수집·Claude Haiku 분류 → `docs/data/events.json` 누적 → Slack 발송 →
대시보드(`docs/index.html`)는 그 데이터를 읽어서 표시.

## 주간 운영 루틴 (5분)

1. **실행 확인**: GitHub Actions 탭에서 `weekly-competitor-monitor` 최근 실행이 초록색인지.
2. **로그 확인**: `logs/run-*.log` 최신 파일에서 `[ERROR]`/`[FATAL]` 검색.
   - 소스 1~2개 실패는 정상 범위(로그만 확인). 전체 FATAL이면 아래 트러블슈팅.
3. **분류 품질 점검**: `docs/data/events.json`에서 최근 주 항목 훑기.
   - 무관 기사가 이벤트로 들어왔으면 → 해당 회사 키워드에 보조어 추가 (아래 참조)
   - `needs_review: true` 항목이 많으면 → ANTHROPIC_API_KEY 상태 확인

## 자주 하는 작업

### 감시 기업 추가
`docs/data/companies.json`의 `companies` 배열에 항목 추가 후 커밋. 필드 규칙은 README 참조.
`co` 필드 집계는 `name`(한글명) 기준이므로 name 중복 금지.

### 검색 키워드 튜닝 (노이즈 제거)
증상: 무관 기사가 자꾸 수집됨 (로그의 `제외(무관)` 라인이 많거나, 대시보드에 이상한 기사).
조치: `keywords_ko`/`keywords_en`에 업종 보조어 추가. 예: `"오공"` → `"오공 접착제"`.
LLM이 무관 판정한 사유는 로그의 rationale에 남아 있으니 그걸 근거로 판단.

### 콘텐츠팜(스팸 매체) 차단
증상: 대시보드/Slack에 시장조사 리포트·자동생성 기사가 등록됨.
조치: `scripts/collect.mjs` 상단 `BLOCK_SOURCES`(매체명/도메인 정규식) 또는 `BLOCK_TITLES`(제목 패턴)에 추가.
현재 차단: IndexBox, AD HOC NEWS, MarketsandMarkets, openPR + "Market Analysis/Forecast/Size" 류 제목.

### 수집 소스 구성 (scripts/collect.mjs의 CONFIG)
- 기업별: 구글뉴스 한국어/영어/중국어(간체·번체)/일본어판 — companies.json의 keywords_ko/en/zh/ja
- 산업 주제 구독: `CONFIG.TOPIC_QUERIES` — 회사 무관 업계 신호("hot melt adhesive" 등). 주제 추가는 여기
- GDELT: 원문 URL 소스. 영문 키워드를 `GDELT_BATCH`개씩 OR로 묶어 배치 호출(기업별 개별 호출은
  Actions 공유 IP 속도제한으로 70%+ 실패했던 이력 있음). 429/네트워크 오류 시 20초 후 1회 재시도.
  기업 귀속은 분류 LLM이 판정(_trade 경로).
- 자사 뉴스룸: companies.json의 `owned_media` URL을 매주 fetch → 링크 목록을 `data/owned-seen.json`과
  diff → 새로 나타난 글만 수집. **첫 등록 주는 베이스라인만 잡고 수집 안 함**(과거 글 폭주 방지).
  회사당 주 `OWNED_MAX_NEW`건 상한. URL 추가만 하면 자동 활성화 — 단 반드시 curl로 200 확인 후 등록,
  JS 렌더링 사이트(로그의 "링크 N건"이 한 자리수)는 효과 없음.
- 중복: URL/제목(출처 꼬리 제거) 1차 + LLM 스토리 판정 2차(`DEDUPE_MODEL`, 애매하면 중복 처리).
  2차 판정된 중복은 **폐기하지 않고 `dup_of` 필드로 마킹 후 보존** — 대시보드·Slack에서만 숨김.
  오판 복구: events.json에서 해당 항목의 `dup_of`/`dup_reason` 필드를 지우면 즉시 재노출.

### 분류 기준 조정
`scripts/collect.mjs`의 `classify()` system 프롬프트에 기준이 명시돼 있음.
중요도 기준을 바꾸려면 그 목록만 수정 (스키마는 건드리지 말 것).

### 분류 모델 교체
`scripts/collect.mjs` 상단 `CONFIG.MODEL`. 기본 `claude-haiku-4-5`(비용),
품질 필요 시 `claude-sonnet-5`. 그 외 모델은 사용자 승인 필요.

### 월간 트렌드 요약
매월 첫 주간 실행에서 최근 31일 이벤트를 `DIGEST_MODEL`(Sonnet)로 요약해 Slack 발송,
`data/digests/YYYY-MM.md`에 보존. 상태는 `data/digest-state.json`(lastDigestMonth) —
실패 시 상태 미갱신으로 다음 주 자동 재시도. 요약 형식·관점은 `monthlyDigest()` system 프롬프트에서 조정.

### 수동 실행
GitHub Actions 탭 → weekly-competitor-monitor → Run workflow.
로컬: `COLLECT_LIMIT=2 node scripts/collect.mjs` (테스트), 환경변수는 README 참조.

## 트러블슈팅

| 증상 | 원인 후보 | 조치 |
|---|---|---|
| Actions 전체 실패 (FATAL) | companies.json 문법 오류 | JSON 파싱 확인 (`node -e "require('./docs/data/companies.json')"` 아님 — `JSON.parse(fs...)`) |
| 분류 배치 전부 실패 | API 키 만료/크레딧 소진 | Anthropic Console에서 키·크레딧 확인 |
| 네이버 수집 0건 | 키 오류 또는 쿼터 초과(일 25,000) | 로그의 naver 에러 코드 확인 |
| Google RSS 간헐 실패 | 일시적 차단 | 다음 주 실행에서 자동 회복. 지속되면 요청 간격(300ms) 늘리기 |
| Slack 미발송 | webhook URL 무효화 | Slack 앱 관리에서 webhook 재발급 → Secret 갱신 |
| 대시보드에 데이터 안 보임 | events.js/json 커밋 누락 | Actions의 commit 스텝 로그 확인 |
| 지도에 배지 없음 | 이벤트 `cc`가 비ISO2 값 | 해당 이벤트의 cc 수정, classify 프롬프트의 country_iso2 지시 확인 |

## 데이터 계약 (절대 깨지 말 것)

- `docs/data/events.json`: append-only. 과거 이벤트 수정/삭제 금지 (오분류 수정은 예외, 로그 남길 것).
- 대시보드가 읽는 필드: `d, co, cc, cat, imp, t, s, src, url` (+ `dup_of` 있으면 숨김). 스키마 변경 시 index.html 동시 수정.
- `data/raw/`, `logs/`: 절대 삭제 금지 (사용자 요구사항: 로그 전부 보존).

## 비용 모니터링

- Claude API: Anthropic Console → Usage. 정상 범위 주 $0.1~0.5 (Haiku).
  주 $2 초과 시 이상(수집량 폭증 또는 루프) — 로그의 배치 수 확인.
- 그 외(GitHub Actions/Pages, 네이버, Slack): 무료 티어로 충분, 과금 없음.

## 대시보드 공유 상태

- 현행: GitHub Pages 공개 URL로 열람 (HANDOVER.md 참조) — 매주 자동 갱신.
- 아티팩트 갱신법(보조): `docs/index.html`을 재발행 (URL: https://claude.ai/code/artifact/2059a8ca-ef05-4c37-a74d-2f0077c2a74f 를 `url` 파라미터로 지정)
- 접근 제한이 필요해지면: Cloudflare Access 전환(무료) — 사용자 결정 필요.
