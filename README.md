# 실버스타 경쟁 상황실 (competitor-monitor)

실버스타케미칼 경쟁사(핵심: Bostik·Henkel + 감시 ~50곳)의 뉴스·마케팅 변화를
주 1회 자동 수집 → LLM 분류 → **세계지도 대시보드** + **Slack 리포트**로 제공.

## 구조

```
docs/              GitHub Pages로 서빙되는 대시보드
  index.html         지도(어디서) + 기업 보드(누가) 통합 화면
  data/companies.json  감시 기업 목록 ← 기업 추가는 여기만 수정
  data/events.json     수집·분류된 이슈 누적 (append-only, 파이프라인이 씀)
scripts/collect.mjs  주간 수집 파이프라인
data/raw/YYYY-MM-DD/ 수집 응답 원문 전부 보존
data/seen.json       중복 제거용 (append-only)
logs/run-*.log       실행 로그 전부 보존
.github/workflows/monitor.yml  매주 월 09:00 KST 자동 실행
```

## 처음 세팅 (1회, 총 ~20분)

1. **GitHub 저장소 생성 & 푸시** — 이 폴더를 새 저장소로.
2. **GitHub Pages 활성화** — Settings → Pages → Source: `main` / `/docs`.
   발급된 URL을 Settings → Variables → `DASHBOARD_URL`에 저장(슬랙 링크용).
3. **Secrets 등록** — Settings → Secrets and variables → Actions:
   | Secret | 발급처 | 비용 |
   |---|---|---|
   | `NAVER_CLIENT_ID` / `NAVER_CLIENT_SECRET` | [네이버 개발자센터](https://developers.naver.com) → 검색 API | 무료 (일 25,000건) |
   | `ANTHROPIC_API_KEY` | [Anthropic Console](https://console.anthropic.com) | 월 $1~5 예상 (Haiku 4.5) |
   | `SLACK_WEBHOOK_URL` | Slack → Apps → Incoming Webhooks → 채널 지정 | 무료 |
4. **첫 실행** — Actions 탭 → weekly-competitor-monitor → Run workflow.

키가 없어도 실행은 됩니다(해당 단계만 건너뛰고 로그에 기록):
네이버 키 없음 → Google News만 수집 / Anthropic 키 없음 → '미분류'로 저장 / Slack 없음 → 발송 생략.

## 로컬 테스트

```bash
npm install
COLLECT_LIMIT=2 node scripts/collect.mjs   # 앞 2개 회사만 수집
```

## 기업 추가 (나머지 50곳)

`docs/data/companies.json`의 `companies` 배열에 추가:

```json
{ "id": "고유id", "name": "한글명", "name_en": "영문명", "tier": 2,
  "hq_cc": "ISO2코드", "hq": "국가/설명", "tags": ["국내"],
  "keywords_ko": ["회사명 접착제"], "keywords_en": ["Company adhesive"] }
```

**검색어 팁**: 회사명이 일반명사와 겹치면(예: 오공) `"오공 접착제"`처럼 보조어를 붙여 노이즈를 줄일 것.

## 실행 모델 / 설계 결정

- **스케줄러**: GitHub Actions cron (PC 꺼져 있어도 동작, 무료)
- **분류 LLM**: `claude-haiku-4-5` ($1/$5 per MTok) — 주간 수백 건 분류에 충분.
  품질 부족 시 `scripts/collect.mjs`의 `CONFIG.MODEL`을 `claude-sonnet-5`로 교체.
- **로그 정책**: 수집 원문(raw)·실행 로그·분류 근거(`why` 필드)·제외 사유까지 전부 git에 커밋 (Actions 로그 90일 제한 회피)
- **보수적 실패 처리**: 소스 하나 실패해도 전체 실행은 계속, 분류 실패 항목은 `needs_review: true`로 표시

## 추후 로드맵

- [ ] 나머지 50개사 리스트 입력
- [ ] TDS/MSDS 아카이브: `docs/docs/<company_id>/` 폴더에 PDF 추가 → 기업 타일에서 링크 (msds-translator 프로젝트와 id 체계 공유)
- [ ] Tier1 온드미디어(뉴스룸) 변경 감지
- [ ] 주간 브리핑 페이지 (시안 B)
