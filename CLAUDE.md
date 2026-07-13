# competitor-monitor

실버스타케미칼(폴리아마이드 핫멜트 접착제, B2B) 경쟁사 모니터링. 핵심 경쟁사는 Bostik·Henkel.

## 원칙

- **로그는 전부 남긴다**: 수집 원문(data/raw), 실행 로그(logs/), LLM 분류 근거(events의 `why`), 무관 판정 사유까지. 삭제 금지, append-only.
- **보수적 실패 처리**: 외부 소스/키 하나가 없거나 실패해도 전체 실행은 계속한다. 실패는 로그로 남기고 해당 단계만 건너뛴다.
- **가볍게 유지**: 서버 없음, DB 없음. 정적 대시보드(docs/) + 주간 배치(scripts/) + GitHub Actions가 전부. 새 인프라 추가 전에 반드시 사용자에게 확인.
- **데이터 계약**: 대시보드(docs/index.html)는 events의 `d, co, cc, cat, imp, t, s, src, url` 필드를 읽는다. 스키마 변경 시 양쪽 동시 수정.
- `co` 필드는 companies.json의 `name`(한글명)과 일치해야 기업 보드에 집계된다.

## 구성

- 분류 모델: `scripts/collect.mjs`의 `CONFIG.MODEL` (기본 claude-haiku-4-5, 비용 사유)
- 중복판정·월간요약 모델: `CONFIG.DEDUPE_MODEL` / `CONFIG.DIGEST_MODEL` (claude-sonnet-5, 호출량 적어 비용 미미)
- 지도: docs/index.html에 amCharts worldLow SVG 인라인 (path id = ISO2)
- 스케줄: .github/workflows/monitor.yml — 월요일 09:00 KST

## 테스트

`COLLECT_LIMIT=2 node scripts/collect.mjs` — 키 없이도 Google News 경로 검증 가능.
