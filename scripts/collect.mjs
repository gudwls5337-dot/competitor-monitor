/**
 * 경쟁사 뉴스 수집 파이프라인 (주 1회 실행)
 *
 * 흐름:
 *   docs/data/companies.json 읽기
 *   → 수집: 네이버 API + Google News RSS(5개 언어판) + GDELT(영문 키워드 OR 배치)
 *          + 자사 뉴스룸 변경감지(owned_media diff) (응답 원문 전부 data/raw/에 보존)
 *   → URL/제목 중복 제거 (data/seen.json, append-only)
 *   → Claude(기본 claude-haiku-4-5)로 관련성/중요도/카테고리/국가 분류
 *   → 스토리 중복 판정(Sonnet) — 폐기 아닌 dup_of 마킹 후 보존
 *   → docs/data/events.json에 append (append-only, 삭제 없음)
 *   → Slack Webhook으로 핵심 변화 발송
 *   → 전체 실행 로그를 logs/run-*.log에 저장
 *
 * 환경변수 (없으면 해당 단계만 건너뛰고 로그에 기록 — 실패시키지 않음):
 *   NAVER_CLIENT_ID / NAVER_CLIENT_SECRET  네이버 뉴스 검색
 *   ANTHROPIC_API_KEY                      LLM 분류
 *   SLACK_WEBHOOK_URL                      Slack 리포트
 *   COLLECT_LIMIT                          (테스트용) 앞에서 N개 회사만 수집
 *   BACKFILL_FROM / BACKFILL_TO            (1회성) 과거 기간 수집. YYYY-MM-DD
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = {
  MODEL: "claude-haiku-4-5", // 분류 품질이 부족하면 "claude-sonnet-5"로 교체
  DEDUPE_MODEL: "claude-sonnet-5", // 중복 판정은 품질 우선 (호출량 작아 비용 미미: 주 ~$0.02)
  DIGEST_MODEL: "claude-sonnet-5", // 월간 요약 — 월 1회 호출이라 비용 미미(~$0.05)
  LOOKBACK_DAYS: 8,          // 주간 실행 + 1일 겹침(누락 방지)
  NAVER_DISPLAY: 30,
  CLASSIFY_BATCH: 15,
  SLACK_MAX_ITEMS: 8,
  GDELT_BATCH: 8,            // GDELT 배치당 OR 구문 수 (쿼리 길이·속도제한 균형)
  OWNED_MAX_NEW: 10,         // 자사 뉴스룸에서 회사당 1회 실행에 채택할 신규 글 상한 (사이트 개편 시 폭주 방지)
  // 산업 주제 구독: 특정 회사가 아닌 업계 전체 신호(신기술·전시·업계지 기사)를 잡는 그물
  TOPIC_QUERIES: [
    { q: '"hot melt adhesive"', lang: "en" },
    { q: '"polyamide adhesive"', lang: "en" },
    { q: "핫멜트 접착제", lang: "ko" },
    // 마케팅·시장이슈 확장 (2026-07): 전시회(B2B 마케팅 무대)·원료 가격(시장 선행지표)·수출시장
    { q: '"China Adhesive"', lang: "en" },       // 아시아 최대 접착제 전시회
    { q: "FEICA adhesive", lang: "en" },         // 유럽 접착제 협회 컨퍼런스
    { q: '"dimer acid"', lang: "en" },           // PA 핫멜트 핵심 원료 — 가격·수급 신호
    { q: "polyamide resin price", lang: "en" },  // 원료 가격 동향
    { q: '"hot melt" (Vietnam OR Indonesia OR Thailand)', lang: "en" }, // 동남아 수출시장
  ],
};
const CATEGORIES = ["신제품","투자·증설","M&A","가격","마케팅·유통","전시·행사","실적·공시","온드미디어","인사·조직","기타"];

/* 콘텐츠팜/자동생성 매체 차단 — 신뢰성 확보용 (신규 스팸 매체 발견 시 여기 추가) */
const BLOCK_SOURCES = [/indexbox/i, /ad[\s-]?hoc[\s-]?news/i, /marketsandmarkets/i, /openpr\.com/i, /menafn/i, /wallstreet-online/i, /finanznachrichten/i];
const BLOCK_TITLES = [
  // "share"는 제외 — "Henkel gains market share" 같은 실제 경쟁 기사를 오차단함.
  // 스팸의 "Market Share Report/Size" 류는 나머지 단어와 CAGR 패턴으로 계속 잡힌다.
  /market\s+(analysis|forecast|size|report|outlook|research)/i,
  /market\s+to\s+(surge|soar|reach|hit|grow)/i,
  /projected\s+at\s+(usd|us\$)/i,
  /\bcagr\b/i,
  /\bforecast\s+(to\s+)?20\d{2}/i,
];
const isBlocked = (it) =>
  BLOCK_SOURCES.some((p) => p.test(it.source || "") || p.test(it.url || "")) ||
  BLOCK_TITLES.some((p) => p.test(it.title || ""));

/* ───────── 로그: 전부 남긴다 ───────── */
const logLines = [];
function log(level, msg) {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  logLines.push(line);
  console.log(line);
}
function saveLog() {
  const dir = path.join(ROOT, "logs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  fs.writeFileSync(file, logLines.join("\n") + "\n");
  console.log(`log saved: ${file}`);
}

const readJson = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
};
const writeJson = (p, obj) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
};
function saveRaw(source, companyId, payload) {
  const day = new Date().toISOString().slice(0, 10);
  const p = path.join(ROOT, "data", "raw", day, `${source}-${companyId}.json`);
  writeJson(p, { fetched_at: new Date().toISOString(), source, companyId, payload });
}

/* ───────── 수집기 ───────── */
async function fetchNaver(query) {
  const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(query)}&display=${CONFIG.NAVER_DISPLAY}&sort=date`;
  const r = await fetch(url, {
    headers: {
      "X-Naver-Client-Id": process.env.NAVER_CLIENT_ID,
      "X-Naver-Client-Secret": process.env.NAVER_CLIENT_SECRET,
    },
  });
  if (!r.ok) throw new Error(`naver ${r.status}`);
  const data = await r.json();
  return {
    raw: data,
    items: (data.items || []).map((it) => ({
      title: stripTags(it.title),
      url: it.originallink || it.link,
      date: new Date(it.pubDate).toISOString().slice(0, 10),
      source: "네이버뉴스",
      snippet: stripTags(it.description || ""),
    })),
  };
}

async function fetchGoogleRss(query, lang) {
  const LOC = {
    ko: "hl=ko&gl=KR&ceid=KR:ko",
    en: "hl=en-US&gl=US&ceid=US:en",
    zh: "hl=zh-CN&gl=CN&ceid=CN:zh-Hans",  // 중국 간체판
    tw: "hl=zh-TW&gl=TW&ceid=TW:zh-Hant",  // 대만 번체판
    ja: "hl=ja&gl=JP&ceid=JP:ja",          // 일본판
  };
  const loc = LOC[lang] || LOC.en;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${loc}`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (competitor-monitor)" } });
  if (!r.ok) throw new Error(`google rss ${r.status}`);
  const xml = await r.text();
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const pick = (tag) => {
      const mm = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return mm ? decodeXml(mm[1]) : "";
    };
    const pub = pick("pubDate");
    items.push({
      title: stripTags(pick("title")),
      url: pick("link"),
      date: pub ? new Date(pub).toISOString().slice(0, 10) : "",
      source: stripTags(pick("source")) || "Google News",
      snippet: "",
    });
  }
  return { raw: xml, items };
}

/* GDELT — 원문 URL·출처 도메인을 직접 제공 (무료, 키 불필요). Google News보다 우선 수집 */
const BF_FROM = process.env.BACKFILL_FROM || null;
const BF_TO = process.env.BACKFILL_TO || null;

async function fetchGdelt(query) {
  const range = BF_FROM
    ? `&startdatetime=${BF_FROM.replace(/-/g, "")}000000&enddatetime=${(BF_TO || new Date().toISOString().slice(0, 10)).replace(/-/g, "")}235959&maxrecords=250`
    : `&timespan=1w&maxrecords=100`;
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&format=json${range}`;
  const attempt = () => fetch(url, { headers: { "User-Agent": "competitor-monitor" }, signal: AbortSignal.timeout(30000) });
  let r = await attempt().catch((e) => ({ ok: false, status: `fetch(${e.message})` }));
  if (!r.ok) { // 429(속도제한: Actions 공유 IP로 타 사용자와 쿼터 공유됨) 또는 일시 네트워크 오류 — 20초 후 1회 재시도
    log("WARN", `gdelt ${r.status} — 20초 후 재시도`);
    await new Promise((res) => setTimeout(res, 20000));
    r = await attempt();
  }
  if (!r.ok) throw new Error(`gdelt ${r.status}`);
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("gdelt non-json: " + text.slice(0, 60)); }
  return {
    raw: data,
    items: (data.articles || []).map((a) => ({
      title: stripTags(a.title),
      url: a.url,
      date: a.seendate ? `${a.seendate.slice(0, 4)}-${a.seendate.slice(4, 6)}-${a.seendate.slice(6, 8)}` : "",
      source: a.domain || "GDELT",
      snippet: "",
    })),
  };
}

const stripTags = (s) => String(s || "").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").trim();
const decodeXml = (s) => String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
// 중복 판정용 정규화: 구글뉴스가 제목 뒤에 붙이는 " - 매체명" 꼬리를 제거해
// 같은 기사가 소스별 표기 차이로 중복 등록되는 것을 방지
const normTitle = (s) => stripTags(s).replace(/\s+[-–|]\s+[^-–|]{2,40}$/, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/* ───────── 자사 뉴스룸(owned_media) 변경 감지 ─────────
 * 뉴스에 안 잡히는 업체(특히 중국·중소)의 유일한 신호원.
 * 뉴스룸 페이지의 링크 목록을 이전 실행(data/owned-seen.json)과 비교해 '새로 나타난 글'만 수집.
 * 첫 실행은 베이스라인 등록만 하고 수집하지 않는다(과거 글 폭주 방지).
 * JS 렌더링 사이트는 링크 0건으로 나올 수 있음 — 로그의 링크 수로 판별. */
function extractLinks(html, pageUrl) {
  const links = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = stripTags(m[2]).replace(/\s+/g, " ").trim();
    if (text.length < 12) continue; // 짧은 앵커는 내비게이션/버튼일 확률이 높음
    let url;
    try { url = new URL(m[1], pageUrl).href.split("#")[0]; } catch { continue; }
    if (!/^https?:/.test(url)) continue;
    if (!links.some((l) => l.url === url)) links.push({ url, text });
  }
  return links;
}

async function collectOwnedMedia(companies) {
  const seenPath = path.join(ROOT, "data", "owned-seen.json");
  const ownedSeen = readJson(seenPath, {});
  const items = [];
  for (const c of companies) {
    for (const pageUrl of c.owned_media || []) {
      try {
        const r = await fetch(pageUrl, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; competitor-monitor)" },
          signal: AbortSignal.timeout(20000),
        });
        if (!r.ok) throw new Error(`http ${r.status}`);
        const html = await r.text();
        saveRaw("owned", `${c.id}-${normTitle(pageUrl).slice(0, 20)}`, html);
        const links = extractLinks(html, r.url || pageUrl);
        const rec = ownedSeen[pageUrl];
        if (!rec) {
          ownedSeen[pageUrl] = { baseline_at: new Date().toISOString(), urls: links.map((l) => l.url) };
          log("INFO", `owned [${c.id}] 베이스라인 등록: 링크 ${links.length}건 (다음 실행부터 신규분 수집)`);
          continue;
        }
        const known = new Set(rec.urls);
        const freshLinks = links.filter((l) => !known.has(l.url));
        freshLinks.slice(0, CONFIG.OWNED_MAX_NEW).forEach((l) => items.push({
          title: l.text,
          url: l.url,
          date: "", // 날짜 미상 → 저장 시 수집일로 채워짐
          source: `자사 뉴스룸(${new URL(pageUrl).hostname})`,
          snippet: "",
          companyId: c.id,
        }));
        freshLinks.forEach((l) => rec.urls.push(l.url)); // append-only
        log("INFO", `owned [${c.id}] 링크 ${links.length}건 중 신규 ${freshLinks.length}건${freshLinks.length > CONFIG.OWNED_MAX_NEW ? ` — 상한 ${CONFIG.OWNED_MAX_NEW}건만 채택` : ""}`);
      } catch (e) { log("ERROR", `owned [${c.id}] ${pageUrl} 실패: ${e.message}`); }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  writeJson(seenPath, ownedSeen);
  return items;
}

/* ───────── LLM 분류 ───────── */
async function classify(items, companiesById) {
  if (!process.env.ANTHROPIC_API_KEY) {
    log("WARN", "ANTHROPIC_API_KEY 없음 — 분류 생략, 전 건 '미분류'로 저장");
    return items.map(() => null);
  }
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const out = [];
  for (let i = 0; i < items.length; i += CONFIG.CLASSIFY_BATCH) {
    const batch = items.slice(i, i + CONFIG.CLASSIFY_BATCH);
    const payload = batch.map((it, idx) => ({
      index: idx,
      company: it.companyId === "_trade"
        ? "(업계 전문지 기사 — 주체 기업을 판단할 것)"
        : companiesById[it.companyId]?.name_en || it.companyId,
      title: it.title,
      snippet: it.snippet?.slice(0, 300) || "",
      source: it.source,
    }));
    try {
      const resp = await client.messages.create({
        model: CONFIG.MODEL,
        max_tokens: 4096,
        system: [
          "당신은 폴리아마이드 핫멜트 접착제 제조사 '실버스타케미칼'(한국, 수출 비중 70%)의 경쟁정보 분석가다.",
          "각 뉴스 항목을 분류하라. 판단 기준:",
          "- relevant: 해당 회사의 접착제/화학 사업과 실제로 관련 있는가 (동명이인·스포츠·무관 기사는 false)",
          "- 시장조사 리포트(예: 'Market Analysis/Forecast/Size' 류), 애그리게이터 자동생성 기사 등 구체적 사실(발표·수치·제품명·투자·계약)이 없는 글은 relevant=false",
          "- importance 3(높음): 신제품 출시, 공장 증설/신설, M&A, 가격 정책, 신규 시장 진출, 한국/동남아 시장 관련, 친환경·바이오 소재, 대형 마케팅·브랜드 전략(리브랜딩, 주요 캠페인, 핵심 고객사 확보)",
          "- importance 2(보통): 실적 발표, 전시회 참가, 유통/파트너십, 인증 획득, 디지털 마케팅·콘텐츠 활동, 채용 확대",
          "- importance 1(낮음): 단순 언급, 광고성, 접착제 무관 사업부 소식",
          `- category: ${CATEGORIES.join(", ")} 중 하나`,
          "- country_iso2: 이슈가 발생한 지역(공장 위치, 진출 시장 등)의 ISO 3166-1 alpha-2 코드. 불명확하면 본사 국가.",
          "- summary_ko: 한 문장 요약(한국어), implication_ko: 실버스타 관점 시사점 한 문장, rationale: 분류 근거 한 문장",
          "- company_name: 기사의 주체 기업명(제시된 company를 그대로 쓰되, '(업계 전문지…)'인 항목은 기사에서 판단해 기입, 특정 불가면 '업계')",
          "- 업계 전문지 기사는 핫멜트/PA/접착제 산업의 구체적 사건(신제품, 인수, 증설, 인물)일 때만 relevant=true. 일반 기고/광고는 false.",
        ].join("\n"),
        messages: [{ role: "user", content: JSON.stringify(payload, null, 1) }],
        output_config: {
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["results"],
              properties: {
                results: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["index","relevant","importance","category","country_iso2","summary_ko","implication_ko","rationale","company_name"],
                    properties: {
                      index: { type: "integer" },
                      company_name: { type: "string" },
                      relevant: { type: "boolean" },
                      importance: { type: "integer", enum: [1, 2, 3] },
                      category: { type: "string", enum: CATEGORIES },
                      country_iso2: { type: "string" },
                      summary_ko: { type: "string" },
                      implication_ko: { type: "string" },
                      rationale: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      });
      const text = resp.content.find((b) => b.type === "text")?.text || "{}";
      const results = JSON.parse(text).results || [];
      const byIndex = Object.fromEntries(results.map((r) => [r.index, r]));
      batch.forEach((_, idx) => out.push(byIndex[idx] || null));
      log("INFO", `분류 배치 ${i / CONFIG.CLASSIFY_BATCH + 1}: ${batch.length}건 → 응답 ${results.length}건 (in ${resp.usage.input_tokens}tok / out ${resp.usage.output_tokens}tok)`);
    } catch (e) {
      log("ERROR", `분류 배치 실패 (${e.message}) — 해당 배치 '미분류' 처리`);
      batch.forEach(() => out.push(null));
    }
  }
  return out;
}

/* ───────── 스토리 단위 중복 판정 (LLM) ─────────
 * 같은 근본 사건(투자 발표, 인수, 신제품 등)을 다룬 기사는 매체가 달라도 1건만 노출한다.
 * 사용자 방침: 애매하면 중복으로 처리 (놓치는 것보다 중복 등록이 더 나쁨)
 * 폐기하지 않고 dup_of 마킹 후 보존한다(append-only 원칙) — 대시보드·Slack만 제외.
 * 오판이면 events.json에서 dup_of 필드를 지우면 즉시 복구된다. */
async function dedupeStories(newEvents, existingRecent) {
  if (!process.env.ANTHROPIC_API_KEY || newEvents.length === 0) return newEvents;
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const payload = {
    existing: existingRecent.slice(0, 40).map((e) => ({ id: e.id, company: e.co, date: e.d, title: e.t })),
    new: newEvents.map((e, i) => ({ index: i, company: e.co, date: e.d, title: e.t, summary: (e.s || "").slice(0, 120) })),
  };
  try {
    const resp = await client.messages.create({
      model: CONFIG.DEDUPE_MODEL,
      max_tokens: 2048,
      system: [
        "뉴스 이벤트 중복 판정기. 같은 근본 사건(같은 투자 발표, 같은 인수, 같은 신제품, 같은 실적, 같은 ESG 발표)을 다룬 기사는 매체·표현·언어가 달라도 중복이다.",
        "판정 기준은 공격적으로: 같은 회사의 비슷한 시기(±7일) 겹치는 주제면 전부 중복으로 간주하라. 애매하면 중복이다.",
        "예: 한 회사의 투자 발표를 여러 매체가 각자 다른 제목으로 보도(설비 투자/R&D 강화/시장 공략/공급망 구축 등)해도 전부 같은 사건 → 가장 정보량 많은 1건만 남기고 drop.",
        "new 배열의 각 항목에 대해, existing에 이미 같은 사건이 있거나 new 내 더 앞선 index와 같은 사건이면 그 index를 drop에 담아라.",
        "drop 항목마다 of 필드에 살아남는 원본을 지목하라: existing 항목이면 그 id, new 배열 항목이면 'new:<index>' 형식.",
        "완전히 다른 사건(다른 발표, 다른 지역의 별개 사업)만 남긴다.",
      ].join("\n"),
      messages: [{ role: "user", content: JSON.stringify(payload) }],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object", additionalProperties: false, required: ["drop"],
            properties: {
              drop: {
                type: "array",
                items: {
                  type: "object", additionalProperties: false, required: ["index", "reason", "of"],
                  properties: { index: { type: "integer" }, reason: { type: "string" }, of: { type: "string" } },
                },
              },
            },
          },
        },
      },
    });
    const drops = JSON.parse(resp.content.find((b) => b.type === "text")?.text || "{}").drop || [];
    drops.forEach((d) => {
      const ev = newEvents[d.index];
      if (!ev) return;
      const m = /^new:(\d+)$/.exec(d.of || "");
      ev.dup_of = (m ? newEvents[+m[1]]?.id : d.of) || "unknown";
      ev.dup_reason = d.reason;
      log("INFO", `중복(스토리) 마킹: ${ev.t.slice(0, 70)} — ${d.reason}`);
    });
  } catch (e) {
    log("ERROR", `스토리 중복판정 실패(${e.message}) — 이번 실행은 생략`);
  }
  return newEvents; // dup_of 마킹된 항목 포함 전체 반환 (보존)
}

/* ───────── 월간 트렌드 요약 ─────────
 * 매월 첫 실행에서 최근 31일 이벤트를 요약해 Slack 발송 + data/digests/에 보존.
 * 목적: 이벤트 '피드'가 아닌 '인사이트' 전달 (사용자 목표: 마케팅·시장이슈 파악).
 * 실패 시 상태를 갱신하지 않으므로 다음 주 실행에서 자동 재시도된다. */
async function monthlyDigest(events) {
  const month = new Date().toISOString().slice(0, 7);
  const statePath = path.join(ROOT, "data", "digest-state.json");
  const state = readJson(statePath, {});
  if (state.lastDigestMonth === month) return;
  if (!process.env.ANTHROPIC_API_KEY) { log("WARN", "월간 요약 생략 — ANTHROPIC_API_KEY 없음"); return; }
  const cut = new Date(Date.now() - 31 * 864e5).toISOString().slice(0, 10);
  const recent = events.filter((e) => e.d >= cut && !e.dup_of);
  if (recent.length === 0) { log("INFO", "월간 요약 생략 — 최근 31일 이벤트 없음"); return; }
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  try {
    const payload = recent.slice(0, 80).map((e) => ({ d: e.d, co: e.co, cat: e.cat, imp: e.imp, t: e.t, s: e.s }));
    const resp = await client.messages.create({
      model: CONFIG.DIGEST_MODEL,
      max_tokens: 1500,
      system: [
        "당신은 폴리아마이드 핫멜트 접착제 제조사 '실버스타케미칼'(한국, 수출 비중 70%)의 경쟁정보 분석가다.",
        "최근 한 달간 수집된 경쟁사 이벤트 목록을 받아 월간 동향 요약을 작성하라.",
        "형식: Slack 메시지용 플레인 텍스트. 마크다운 헤더(#) 금지, *굵게*와 '- ' 불릿만 사용.",
        "구성: ① 핵심 동향 3~5개 불릿(각 1~2문장, 회사명 명시) ② 마지막에 '▶ 실버스타 시사점:' 2~3문장.",
        "전체 700자 이내. 목록에 있는 사실만 쓰고 근거 없는 추측 금지. 마케팅·시장 관점(전시회, 시장 진출, 가격, 브랜드 움직임)을 우선하라.",
      ].join("\n"),
      messages: [{ role: "user", content: JSON.stringify(payload) }],
    });
    const text = resp.content.find((b) => b.type === "text")?.text?.trim() || "";
    if (!text) throw new Error("빈 응답");
    const outPath = path.join(ROOT, "data", "digests", `${month}.md`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `# ${month} 월간 경쟁사 동향 (이벤트 ${recent.length}건 기반)\n\n${text}\n`);
    if (process.env.SLACK_WEBHOOK_URL) {
      const r = await fetch(process.env.SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `📈 *월간 경쟁사 동향 요약 (${month})*\n\n${text}` }),
      });
      if (!r.ok) throw new Error(`slack ${r.status}`);
    }
    writeJson(statePath, { ...state, lastDigestMonth: month });
    log("INFO", `월간 요약 완료 (${recent.length}건 기반, in ${resp.usage.input_tokens}tok / out ${resp.usage.output_tokens}tok) → data/digests/${month}.md`);
  } catch (e) {
    log("ERROR", `월간 요약 실패(${e.message}) — 다음 실행에서 재시도`);
  }
}

/* ───────── Slack ───────── */
async function sendSlack(newEvents, stats) {
  if (!process.env.SLACK_WEBHOOK_URL) {
    log("WARN", "SLACK_WEBHOOK_URL 없음 — Slack 발송 생략");
    return;
  }
  const top = [...newEvents].sort((a, b) => b.imp - a.imp || b.d.localeCompare(a.d)).slice(0, CONFIG.SLACK_MAX_ITEMS);
  const impIcon = { 3: "🔴", 2: "🟡", 1: "⚪" };
  const lines = top.map((e) => `${impIcon[e.imp] || "⚪"} *${e.co}* [${e.cat}] <${e.url}|${e.t}>\n    ↳ ${e.s}`);
  const text = [
    `📡 *핫멜트 업체 모니터 — 주간 리포트* (${new Date().toISOString().slice(0, 10)})`,
    `신규 이슈 ${newEvents.length}건 · 높음 ${newEvents.filter((e) => e.imp === 3).length}건 · 수집 ${stats.collected}건 중 관련 ${stats.relevant}건`,
    "",
    ...(lines.length ? lines : ["이번 주 신규 이슈 없음"]),
    "",
    `<${stats.dashboardUrl || "https://GITHUB_PAGES_URL"}|📊 대시보드에서 전체 보기>`,
  ].join("\n");
  const r = await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  log(r.ok ? "INFO" : "ERROR", `Slack 발송 ${r.ok ? "성공" : `실패 ${r.status}`}`);
}

/* ───────── 메인 ───────── */
async function main() {
  log("INFO", `수집 시작 (model=${CONFIG.MODEL}, lookback=${CONFIG.LOOKBACK_DAYS}일)`);
  const companiesFile = readJson(path.join(ROOT, "docs", "data", "companies.json"), null);
  if (!companiesFile) throw new Error("docs/data/companies.json 없음");
  let companies = companiesFile.companies;
  if (process.env.COLLECT_LIMIT) companies = companies.slice(0, +process.env.COLLECT_LIMIT);
  const companiesById = Object.fromEntries(companies.map((c) => [c.id, c]));
  log("INFO", `감시 기업 ${companies.length}곳`);

  const cutoff = BF_FROM || new Date(Date.now() - CONFIG.LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10);
  if (BF_FROM) log("INFO", `백필 모드: ${BF_FROM} ~ ${BF_TO || "현재"}`);
  const seen = readJson(path.join(ROOT, "data", "seen.json"), { urls: [], titles: [] });
  const seenUrls = new Set(seen.urls);
  const seenTitles = new Set(seen.titles);
  const hasNaver = !!(process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET);
  if (!hasNaver) log("WARN", "네이버 API 키 없음 — 네이버 수집 생략 (Google News만 사용)");

  /* 1. 수집 */
  const collected = [];
  for (const c of companies) {
    const queries = [
      ...(c.keywords_ko || []).map((q) => ({ q, lang: "ko" })),
      ...(c.keywords_en || []).map((q) => ({ q, lang: "en" })),
      ...(c.keywords_zh || []).map((q) => ({ q, lang: c.hq_cc === "TW" ? "tw" : "zh" })),
      ...(c.keywords_ja || []).map((q) => ({ q, lang: "ja" })),
    ];
    for (const { q, lang } of queries) {
      // 네이버 (한국어 쿼리만)
      if (hasNaver && lang === "ko") {
        try {
          const { raw, items } = await fetchNaver(q);
          saveRaw("naver", `${c.id}-${normTitle(q).slice(0, 20)}`, raw);
          items.forEach((it) => collected.push({ ...it, companyId: c.id }));
          log("INFO", `naver [${c.id}] "${q}" → ${items.length}건`);
        } catch (e) { log("ERROR", `naver [${c.id}] "${q}" 실패: ${e.message}`); }
      }
      // Google News RSS (백필 시 날짜 연산자 추가)
      try {
        const gq = BF_FROM ? `${q} after:${BF_FROM}${BF_TO ? ` before:${BF_TO}` : ""}` : q;
        const { raw, items } = await fetchGoogleRss(gq, lang);
        saveRaw("google", `${c.id}-${lang}-${normTitle(q).slice(0, 20)}`, raw);
        items.forEach((it) => collected.push({ ...it, companyId: c.id }));
        log("INFO", `google [${c.id}] "${q}" (${lang}) → ${items.length}건`);
      } catch (e) { log("ERROR", `google [${c.id}] "${q}" 실패: ${e.message}`); }
      await new Promise((r) => setTimeout(r, 300)); // rate limit 예방
    }
  }
  /* 1b. GDELT — 기업 영문 키워드를 OR로 묶어 배치 호출 (원문 URL 확보용)
   * 기업별 개별 호출(57회)은 무료 API 속도제한으로 70%+가 429 실패했음(2026-07-09 로그).
   * 배치당 GDELT_BATCH개 구문을 OR로 묶어 호출 수를 ~1/8로 줄인다.
   * 어느 기업 기사인지는 분류 LLM이 판정(_trade 경로 재사용). */
  const enPhrases = companies.flatMap((c) => c.keywords_en || []);
  for (let i = 0; i < enPhrases.length; i += CONFIG.GDELT_BATCH) {
    const group = enPhrases.slice(i, i + CONFIG.GDELT_BATCH);
    const q = "(" + group.map((p) => `"${p.replace(/"/g, "")}"`).join(" OR ") + ")";
    const label = `batch${i / CONFIG.GDELT_BATCH + 1}`;
    try {
      const { raw, items } = await fetchGdelt(q);
      saveRaw("gdelt", label, raw);
      items.forEach((it) => collected.push({ ...it, companyId: "_trade" }));
      log("INFO", `gdelt [${label}] ${group.length}개 구문 → ${items.length}건`);
    } catch (e) { log("ERROR", `gdelt [${label}] 실패: ${e.message}`); }
    await new Promise((r) => setTimeout(r, 6000)); // 무료 API 속도제한 예방
  }

  /* 1c. 자사 뉴스룸 변경 감지 */
  const ownedItems = await collectOwnedMedia(companies);
  ownedItems.forEach((it) => collected.push(it));
  log("INFO", `owned 신규 후보 ${ownedItems.length}건`);

  /* 1d. 산업 주제 구독 (회사 무관 업계 전체 신호) */
  for (const { q, lang } of CONFIG.TOPIC_QUERIES) {
    try {
      const gq = BF_FROM ? `${q} after:${BF_FROM}${BF_TO ? ` before:${BF_TO}` : ""}` : q;
      const { raw, items } = await fetchGoogleRss(gq, lang);
      saveRaw("topic", normTitle(q).slice(0, 24), raw);
      items.forEach((it) => collected.push({ ...it, companyId: "_trade" }));
      log("INFO", `topic "${q}" (${lang}) → ${items.length}건`);
    } catch (e) { log("ERROR", `topic "${q}" 실패: ${e.message}`); }
  }
  log("INFO", `수집 합계 ${collected.length}건`);

  /* 2. 기간 필터 + 중복 제거 */
  const fresh = [];
  const batchTitles = new Set();
  let blocked = 0;
  for (const it of collected) {
    if (!it.url || !it.title) continue;
    if (it.date && it.date < cutoff) continue;
    if (BF_TO && it.date && it.date > BF_TO) continue;
    const tkey = normTitle(it.title);
    if (seenUrls.has(it.url) || seenTitles.has(tkey) || batchTitles.has(tkey)) continue;
    if (isBlocked(it)) {
      blocked++;
      seenUrls.add(it.url); seenTitles.add(tkey); // 다음 주 재평가 방지
      log("INFO", `차단(콘텐츠팜): [${it.companyId}] ${it.title.slice(0, 80)} — ${it.source}`);
      continue;
    }
    batchTitles.add(tkey);
    fresh.push(it);
  }
  log("INFO", `기간·중복 필터 후 ${fresh.length}건 (콘텐츠팜 차단 ${blocked}건)`);

  /* 3. LLM 분류 */
  const results = await classify(fresh, companiesById);
  const newEvents = [];
  const byName = new Map();
  companies.forEach((cc) => {
    byName.set(cc.name.toLowerCase(), cc);
    if (cc.name_en) byName.set(cc.name_en.toLowerCase(), cc);
  });
  fresh.forEach((it, i) => {
    const r = results[i];
    const c = companiesById[it.companyId]
      || byName.get((r?.company_name || "").toLowerCase())          // 업계지 기사가 감시 기업 건이면 연결
      || { id: "_trade", name: r?.company_name || "업계", hq_cc: "US" };
    if (r && !r.relevant) {
      log("INFO", `제외(무관): [${c.name}] ${it.title} — ${r.rationale}`);
      return;
    }
    newEvents.push({
      id: `${it.date || new Date().toISOString().slice(0, 10)}-${normTitle(it.title).slice(0, 40)}`,
      d: it.date || new Date().toISOString().slice(0, 10),
      co: c.name,
      company_id: c.id,
      cc: r?.country_iso2?.toUpperCase() || c.hq_cc,   // 분류 실패 시 본사 국가 폴백
      cat: r?.category || "기타",
      imp: r?.importance || 1,
      t: it.title,
      s: r?.summary_ko ? `${r.summary_ko} ${r.implication_ko || ""}`.trim() : "(미분류 — LLM 키 없음 또는 분류 실패)",
      why: r?.rationale || null,                        // 분류 근거도 보존
      src: it.source,
      url: it.url,
      collected_at: new Date().toISOString(),
      needs_review: !r,
    });
  });
  log("INFO", `신규 이벤트 ${newEvents.length}건 (무관 제외 ${fresh.length - newEvents.length}건)`);

  /* 4. 스토리 단위 중복 마킹 후 저장 (append-only — 중복도 dup_of 표시 후 보존) */
  const eventsPath = path.join(ROOT, "docs", "data", "events.json");
  const events = readJson(eventsPath, []);
  const recentCut = new Date(Date.now() - 21 * 864e5).toISOString().slice(0, 10);
  const marked = await dedupeStories(newEvents, events.filter((e) => e.d >= recentCut && !e.dup_of));
  const finalNew = marked.filter((e) => !e.dup_of);
  if (finalNew.length !== marked.length)
    log("INFO", `스토리 중복 ${marked.length - finalNew.length}건 마킹(보존) → 노출 ${finalNew.length}건`);
  events.push(...marked);
  events.sort((a, b) => b.d.localeCompare(a.d));
  writeJson(eventsPath, events);
  // file:// 로 열어도 동작하도록 JS 사본도 생성 (fetch가 CORS로 막히는 환경 대비)
  fs.writeFileSync(path.join(ROOT, "docs", "data", "events.js"),
    "window.__EVENTS__=" + JSON.stringify(events) + ";");
  fs.writeFileSync(path.join(ROOT, "docs", "data", "companies.js"),
    "window.__COMPANIES__=" + JSON.stringify(companiesFile) + ";");
  fresh.forEach((it) => { seenUrls.add(it.url); seenTitles.add(normTitle(it.title)); });
  writeJson(path.join(ROOT, "data", "seen.json"), { urls: [...seenUrls], titles: [...seenTitles] });
  log("INFO", `events.json 누적 ${events.length}건 저장`);

  /* 5. Slack */
  await sendSlack(finalNew, { collected: collected.length, relevant: finalNew.length, dashboardUrl: process.env.DASHBOARD_URL });

  /* 6. 월간 트렌드 요약 (매월 첫 실행에서만 발동) */
  await monthlyDigest(events);

  saveLog();
}

main().catch((e) => {
  log("FATAL", e.stack || e.message);
  saveLog();
  process.exit(1);
});
