/**
 * 경쟁사 뉴스 수집 파이프라인 (주 1회 실행)
 *
 * 흐름:
 *   docs/data/companies.json 읽기
 *   → 네이버 뉴스 API + Google News RSS 수집 (응답 원문 전부 data/raw/에 보존)
 *   → URL/제목 중복 제거 (data/seen.json, append-only)
 *   → Claude(기본 claude-haiku-4-5)로 관련성/중요도/카테고리/국가 분류
 *   → docs/data/events.json에 append (append-only, 삭제 없음)
 *   → Slack Webhook으로 핵심 변화 발송
 *   → 전체 실행 로그를 logs/run-*.log에 저장
 *
 * 환경변수 (없으면 해당 단계만 건너뛰고 로그에 기록 — 실패시키지 않음):
 *   NAVER_CLIENT_ID / NAVER_CLIENT_SECRET  네이버 뉴스 검색
 *   ANTHROPIC_API_KEY                      LLM 분류
 *   SLACK_WEBHOOK_URL                      Slack 리포트
 *   COLLECT_LIMIT                          (테스트용) 앞에서 N개 회사만 수집
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = {
  MODEL: "claude-haiku-4-5", // 분류 품질이 부족하면 "claude-sonnet-5"로 교체
  LOOKBACK_DAYS: 8,          // 주간 실행 + 1일 겹침(누락 방지)
  NAVER_DISPLAY: 30,
  CLASSIFY_BATCH: 15,
  SLACK_MAX_ITEMS: 8,
};
const CATEGORIES = ["신제품","투자·증설","M&A","가격","마케팅·유통","전시·행사","실적·공시","온드미디어","인사·조직","기타"];

/* 콘텐츠팜/자동생성 매체 차단 — 신뢰성 확보용 (신규 스팸 매체 발견 시 여기 추가) */
const BLOCK_SOURCES = [/indexbox/i, /ad[\s-]?hoc[\s-]?news/i, /marketsandmarkets/i, /openpr\.com/i];
const BLOCK_TITLES = [/market\s+(analysis|forecast|size|report|outlook|share|research)/i, /\bforecast\s+(to\s+)?20\d{2}/i];
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
  const loc = lang === "ko" ? "hl=ko&gl=KR&ceid=KR:ko" : "hl=en-US&gl=US&ceid=US:en";
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
async function fetchGdelt(query) {
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&maxrecords=30&format=json&timespan=1w`;
  const r = await fetch(url, { headers: { "User-Agent": "competitor-monitor" } });
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
const normTitle = (s) => stripTags(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

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
      company: companiesById[it.companyId]?.name_en || it.companyId,
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
          "- importance 3(높음): 신제품 출시, 공장 증설/신설, M&A, 가격 정책, 한국/동남아 시장 관련, 친환경·바이오 소재",
          "- importance 2(보통): 실적 발표, 전시회, 유통/파트너십, 채용 확대",
          "- importance 1(낮음): 단순 언급, 광고성, 접착제 무관 사업부 소식",
          `- category: ${CATEGORIES.join(", ")} 중 하나`,
          "- country_iso2: 이슈가 발생한 지역(공장 위치, 진출 시장 등)의 ISO 3166-1 alpha-2 코드. 불명확하면 본사 국가.",
          "- summary_ko: 한 문장 요약(한국어), implication_ko: 실버스타 관점 시사점 한 문장, rationale: 분류 근거 한 문장",
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
                    required: ["index","relevant","importance","category","country_iso2","summary_ko","implication_ko","rationale"],
                    properties: {
                      index: { type: "integer" },
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

  const cutoff = new Date(Date.now() - CONFIG.LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10);
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
      // GDELT (영문 쿼리만 — 원문 URL 확보, Google News보다 먼저 수집해 중복 시 원문 URL이 남게 함)
      if (lang === "en") {
        try {
          const { raw, items } = await fetchGdelt(q);
          saveRaw("gdelt", `${c.id}-${normTitle(q).slice(0, 20)}`, raw);
          items.forEach((it) => collected.push({ ...it, companyId: c.id }));
          log("INFO", `gdelt [${c.id}] "${q}" → ${items.length}건`);
        } catch (e) { log("ERROR", `gdelt [${c.id}] "${q}" 실패: ${e.message}`); }
      }
      // Google News RSS
      try {
        const { raw, items } = await fetchGoogleRss(q, lang);
        saveRaw("google", `${c.id}-${lang}-${normTitle(q).slice(0, 20)}`, raw);
        items.forEach((it) => collected.push({ ...it, companyId: c.id }));
        log("INFO", `google [${c.id}] "${q}" (${lang}) → ${items.length}건`);
      } catch (e) { log("ERROR", `google [${c.id}] "${q}" 실패: ${e.message}`); }
      await new Promise((r) => setTimeout(r, 300)); // rate limit 예방
    }
  }
  log("INFO", `수집 합계 ${collected.length}건`);

  /* 2. 기간 필터 + 중복 제거 */
  const fresh = [];
  const batchTitles = new Set();
  let blocked = 0;
  for (const it of collected) {
    if (!it.url || !it.title) continue;
    if (it.date && it.date < cutoff) continue;
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
  fresh.forEach((it, i) => {
    const r = results[i];
    const c = companiesById[it.companyId];
    if (r && !r.relevant) {
      log("INFO", `제외(무관): [${c.name}] ${it.title} — ${r.rationale}`);
      return;
    }
    newEvents.push({
      id: `${it.date || "unknown"}-${normTitle(it.title).slice(0, 40)}`,
      d: it.date || new Date().toISOString().slice(0, 10),
      co: c.name,
      company_id: c.id,
      cc: r?.country_iso2?.toUpperCase() || c.hq_cc,   // 분류 실패 시 본사 국가 폴백
      loc: r?.country_iso2?.toUpperCase() || c.hq_cc,
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

  /* 4. 저장 (append-only) */
  const eventsPath = path.join(ROOT, "docs", "data", "events.json");
  const events = readJson(eventsPath, []);
  events.push(...newEvents);
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
  const relevant = newEvents.length;
  await sendSlack(newEvents, { collected: collected.length, relevant, dashboardUrl: process.env.DASHBOARD_URL });

  saveLog();
}

main().catch((e) => {
  log("FATAL", e.stack || e.message);
  saveLog();
  process.exit(1);
});
