# 📡 핫멜트 업체 상황실 — 최종 정리 (2026-07-09 구축 완료)

## 한눈에

| 항목 | 내용 |
|---|---|
| **공유 대시보드** | https://gudwls5337-dot.github.io/competitor-monitor/ (누구나 열람, 매주 자동 갱신) |
| **Slack 리포트** | #경쟁사-모니터 채널, 매주 월 09:00 자동 발송 |
| **저장소** | https://github.com/gudwls5337-dot/competitor-monitor (공개) |
| **자동 실행** | GitHub Actions cron — 월 09:00 KST (수동: Actions 탭 → Run workflow) |
| **감시 기업** | 59곳 (핵심: Bostik·Henkel / 사용자 큐레이션 50위 리스트 기반) |
| **운영 모델** | 다음 세션부터 Sonnet — "OPERATIONS.md 보고 진행" 이라고 지시 |

## 파이프라인 (주 1회)

```
수집: 구글뉴스 5개판(한/영/중간체/중번체/일) × 기업별 검색어
    + 산업 주제 구독("hot melt adhesive" 등 3개)
    + GDELT(전세계 65개 언어, 원문 URL)
→ 필터: 기간(8일) → URL/제목 중복 → 콘텐츠팜 차단(IndexBox·AD HOC NEWS 등)
→ 분류: Claude Haiku 4.5 — 관련성/중요도/카테고리/국가/시사점 (근거 로그 보존)
→ 중복: Claude Sonnet 5 — 같은 사건 다중 보도 통합 (애매하면 중복 처리)
→ 저장: docs/data/events.json (append-only) → 대시보드 자동 반영
→ 발송: Slack 핵심 변화 Top 8
```

## 비용 (실측)

- Claude API: **주 $0.1~0.3** (분류 Haiku + 중복판정 Sonnet) — 그 외 전부 무료
- Anthropic 콘솔 크레딧 $5면 수개월. 모니터링: console.anthropic.com → Usage

## 키/비밀값 위치

- GitHub Secrets(암호화): ANTHROPIC_API_KEY, SLACK_WEBHOOK_URL — 운영은 이것만 사용
- 로컬 `.env`(git 제외됨): 로컬 테스트용 사본. 필요 없으면 삭제해도 운영 무관
- 네이버 API: 미등록 (국내 커버리지 강화 시 .env와 Secrets에 추가하면 자동 활성화)

## 남은 선택지 (필요할 때)

1. **접근 제한**: 지금은 링크 공개. 특정인만 → Cloudflare Access 전환 (무료)
2. **네이버 뉴스 API**: 국내 중소 경쟁사(오공·MCS 등) 커버리지 강화
3. **홈페이지 변경감지**: 중국 업체들의 진짜 신호 (뉴스가 안 나오는 곳)
4. **TDS/MSDS 아카이브**: 기업 타일에 문서 연결 (msds-translator와 id 체계 공유)
5. EMS-Chemie는 스위스 Griltex(PA 핫멜트)로 등록 — 다른 EMS면 수정 필요

## 문서 안내

- `OPERATIONS.md` — 운영 세션용 (주간 점검·키워드 튜닝·스팸 차단·트러블슈팅)
- `README.md` — 구조·세팅·기업 추가 방법
- `CLAUDE.md` — AI 세션 공통 원칙 (로그 전부 보존, append-only, 보수적 실패 처리)
