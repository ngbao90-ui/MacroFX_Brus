// Core cost-saving step: the LLM never sees or produces HTML. It receives the
// current dashboard.json (with today's live prices already merged in by
// fetch-market.mjs) and returns ONLY a JSON *patch* — the objects that
// actually need to change. render.mjs turns whatever JSON exists into HTML
// afterwards, deterministically and for free.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { callLLM } from './lib/llm-provider.mjs';
import { applyPatch } from './lib/merge-patch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const dataPath = path.join(root, 'data/dashboard.json');

const SYSTEM_PROMPT = `Bạn là trợ lý phân tích Macro FX, duy trì một dashboard G8+NZD (USD, EUR, JPY, GBP, CHF, CAD, AUD, NZD) dạng JSON.

QUY TẮC BẤT BIẾN:
1. Bạn KHÔNG BAO GIỜ output HTML. Bạn chỉ output MỘT object JSON hợp lệ — "patch" — chứa các phần dữ liệu cần thay đổi. Không giải thích, không markdown, không code fence, không text nào khác ngoài JSON.
2. Patch chỉ chứa các object đã thay đổi thật sự (để tiết kiệm token). Nếu một đồng tiền không có tin gì mới, ĐỪNG đưa nó vào "currencies". Nếu một cặp tiền không đổi hướng/không có tin, ĐỪNG đưa nó vào "pairs".
3. QUAN TRỌNG NHẤT — TÍNH LOGIC LIÊN KẾT: nếu bạn thay đổi bất kỳ điều gì về một đồng tiền (score, narrative, forward guidance, sự kiện mới), bạn PHẢI kiểm tra và cập nhật ĐỒNG BỘ mọi nơi khác có liên quan đến đồng tiền đó trong CÙNG MỘT patch:
   - currencies[]: score, macroScore, secondaryScore, stance, narrative, forwardGuidance, latestEvent, scoreHistory (append 1 dòng mới nếu có sự kiện đáng kể, giữ tối đa 5 dòng gần nhất), upcomingEvents.
   - pairs.usd[] và pairs.cross[]: MỌI cặp tiền có chứa đồng tiền đó — cập nhật lại "dots" (3 lớp: macro/kỹ thuật/COT), "structure", "bondYield", "spreadTag", "signalBox", "highlight" (true nếu 3/3 đồng thuận).
   - spotlight.confluence / spotlight.divergence: thêm/bớt/sửa cặp tiền nếu trạng thái 3/3 hoặc phân kỳ thay đổi.
   - narrative.themes: cập nhật nếu có chủ đề vĩ mô lớn thay đổi (banner chính của dashboard).
   - cot[]: chỉ cập nhật nếu có dữ liệu COT mới (thường vào thứ Sáu, dữ liệu Tradingster cắt vào thứ Ba trước đó).
   - riskCalendar: thêm sự kiện mới sắp tới nếu có, có thể xoá sự kiện đã qua ngày.
4. Điểm số (score) 0–10: Score = Macro_Core × 0.70 + Secondary_Factor × 0.30. Macro_Core dựa trên: (a) data thực tế lạm phát/lao động vs mục tiêu, (b) delta vs kỳ vọng thị trường (decay 4 tuần: tuần này 100%, tuần trước 50%, 2 tuần trước 25%), (c) forward expectation (OIS/futures pricing, forward guidance). ≥7.5 = Hawkish · 5.5–7.4 = N-Hawk · 4.5–5.4 = Neutral · <4.5 = N-Dove/Dovish.
5. Với mỗi cặp tiền, "dots" là mảng 3 phần tử ["up"|"down"|"neutral", ...] theo thứ tự [Macro, Kỹ thuật, COT]. 3/3 cùng chiều = confluence mạnh (đặt "highlight": true). Không tự bịa số liệu kỹ thuật (support/resistance) nếu không có cơ sở — có thể giữ nguyên vùng cũ nếu giá chưa phá vỡ.
6. Không đưa ra lời khuyên đầu tư trực tiếp — chỉ mô tả setup/bias theo dữ liệu.
7. Tất cả text bằng tiếng Việt, giữ văn phong ngắn gọn, số liệu cụ thể, giống với văn phong hiện có trong JSON hiện tại (làm mẫu).
8. Nếu bạn có công cụ web_search, chỉ dùng để: (a) kiểm tra tin tức/số liệu vĩ mô mới nhất trong 24-48h qua cho các đồng tiền G8+NZD, (b) vào thứ Sáu, tra cứu Tradingster.com COT data mới nhất để cập nhật object "cot" (Z-score = (net hiện tại - mean 52 tuần) / stdev 52 tuần). Không tìm kiếm quá 6-8 lần.
9. Nếu KHÔNG có gì đáng kể thay đổi so với dữ liệu hiện tại, trả về {} (patch rỗng) — điều này hoàn toàn bình thường và tiết kiệm chi phí.

ĐỊNH DẠNG OUTPUT: một JSON object duy nhất, ví dụ:
{"currencies":[{"code":"CAD","score":3.6,"narrative":"..."}],"pairs":{"usd":[{"code":"USDCAD","price":"1.4210","dots":["up","up","up"],"highlight":true,"signalBox":"..."}],"cross":[]},"spotlight":{"confluence":[...],"divergence":[...]}}`;

function pruneForPrompt(data) {
  // Trim history to keep the prompt small; the LLM only needs recent context.
  const clone = JSON.parse(JSON.stringify(data));
  for (const c of clone.currencies) {
    if (c.scoreHistory) c.scoreHistory = c.scoreHistory.slice(-3);
  }
  return clone;
}

function extractJson(text) {
  const trimmed = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) throw new Error('No JSON object found in LLM response: ' + text.slice(0, 300));
  return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
}

async function main() {
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const today = new Date();
  const isFriday = today.getUTCDay() === 5; // COT / weekly research day
  const dateLabel = today.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

  const promptData = pruneForPrompt(data);
  const userMsg = `Hôm nay là ${dateLabel} (giờ Việt Nam). ${isFriday ? 'Hôm nay là thứ Sáu — hãy kiểm tra và cập nhật object "cot" nếu có dữ liệu Tradingster mới.' : 'Không cần cập nhật "cot" trừ khi có tin đặc biệt.'}

Dữ liệu dashboard hiện tại (giá đã được cập nhật tự động từ FMP, bạn không cần tự tính lại giá FX):
${JSON.stringify(promptData)}

Hãy tìm tin tức vĩ mô mới nhất (nếu có web_search) cho USD, EUR, JPY, GBP, CHF, CAD, AUD, NZD trong 24-48h qua, và trả về JSON patch theo đúng quy tắc trong system prompt.`;

  const useWebSearch = process.env.ENABLE_WEB_SEARCH === 'true' || isFriday;

  const raw = await callLLM({
    system: SYSTEM_PROMPT,
    user: userMsg,
    maxTokens: 8000,
    useWebSearch,
  });

  let patch;
  try {
    patch = extractJson(raw);
  } catch (e) {
    console.error('Failed to parse LLM patch, leaving dashboard.json unchanged.');
    console.error(raw.slice(0, 2000));
    throw e;
  }

  if (Object.keys(patch).length === 0) {
    console.log('LLM returned empty patch — no macro-relevant changes today.');
  } else {
    const merged = applyPatch(data, patch);
    merged.meta.dateLabel = dateLabel;
    merged.meta.updatedAt = new Date().toISOString();
    fs.writeFileSync(dataPath, JSON.stringify(merged, null, 2));
    console.log('Applied patch with keys:', Object.keys(patch));
  }
}

main().catch(e => {
  console.error('llm-update.mjs failed:', e);
  process.exit(1);
});
