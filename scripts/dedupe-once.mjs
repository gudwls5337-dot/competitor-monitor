// 기존 events.json에 스토리 중복제거 1회 적용 (collect.mjs와 동일 기준)
import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";

const FILE = "./docs/data/events.json";
const evs = JSON.parse(fs.readFileSync(FILE, "utf8"));
const client = new Anthropic();

const payload = {
  existing: [],
  new: evs.map((e, i) => ({ index: i, company: e.co, date: e.d, title: e.t, summary: (e.s || "").slice(0, 120) })),
};
const resp = await client.messages.create({
  model: "claude-haiku-4-5",
  max_tokens: 2048,
  system: [
    "뉴스 이벤트 중복 판정기. 같은 근본 사건(같은 투자 발표, 같은 인수, 같은 신제품, 같은 실적, 같은 ESG 발표)을 다룬 기사는 매체·표현·언어가 달라도 중복이다.",
    "판정 기준은 공격적으로: 같은 회사의 비슷한 시기(±7일) 비슷한 주제면 중복으로 간주하라. 애매하면 중복이다.",
    "new 배열에서, 더 앞선 index와 같은 사건인 항목의 index를 drop에 담아라. 각 사건마다 가장 정보량 많은 1건만 남긴다(남길 것은 drop에 넣지 말 것).",
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
              type: "object", additionalProperties: false, required: ["index", "reason"],
              properties: { index: { type: "integer" }, reason: { type: "string" } },
            },
          },
        },
      },
    },
  },
});
const drops = JSON.parse(resp.content.find((b) => b.type === "text")?.text || "{}").drop || [];
const dropSet = new Set(drops.map((d) => d.index));
drops.forEach((d) => console.log("제거:", evs[d.index]?.t?.slice(0, 65), "—", d.reason));
const kept = evs.filter((_, i) => !dropSet.has(i));
fs.writeFileSync(FILE, JSON.stringify(kept, null, 2));
console.log(`${evs.length} → ${kept.length}건`);
