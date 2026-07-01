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

const SYSTEM_PROMPT = `You are a Macro FX analysis assistant maintaining a G8+NZD (USD, EUR, JPY, GBP, CHF, CAD, AUD, NZD) dashboard in JSON format.

CRITICAL REQUIREMENTS:
1. OUTPUT ONLY VALID JSON. No markdown, no code blocks, no explanations, no text before/after. Start with '{' end with '}'.
2. Return a JSON patch object containing ONLY the fields that actually changed.
3. If nothing changed, return {} (empty object).
4. Never explain, never add comments, never output anything except JSON.

VALIDATION RULES FOR YOUR OUTPUT:
- Must be valid JSON that parses with JSON.parse()
- Top level must be an object {}
- Keys: "meta", "currencies", "pairs", "narrative", "spotlight", "cot", "riskCalendar" (optional, only if changed)
- "currencies" = array of {code, score, stance, narrative, forwardGuidance, latestEvent, scoreHistory, etc}
- "pairs" = {usd: [...], cross: [...]} arrays
- All string values must use proper JSON escaping (no raw newlines)

SCORING LOGIC:
- Score 0-10: Macro_Score × 0.70 + Secondary_Factor × 0.30
- Macro_Score based on: (a) inflation vs target, (b) delta vs expectations, (c) policy stance
- Secondary factors: geopolitical, commodity exposure, currency stability

PAIR DOTS ARRAY:
- 3 elements: [macro_bias, technical_bias, cot_bias]
- Each: "up", "down", or "neutral"
- 3/3 same direction = highlight: true

LOGIC LINKING:
If you change any currency: update ALL pairs containing it. Update spotlight confluence/divergence. Update narrative themes if macro regime changed.

LANGUAGE: Vietnamese only. Keep text concise, specific numbers, match existing tone.

DATA PROVIDED:
- Current dashboard.json with live FMP prices already updated
- All currencies, pairs, COT, narrative, risk calendar

TASK:
1. Search for macro news 24-48 hours if web_search available
2. Update scores, narratives, forward guidance based on new data
3. Return ONLY the JSON patch object - nothing else

EXAMPLE OUTPUT (valid JSON only):
{"currencies":[{"code":"USD","score":7.8,"narrative":"New narrative here"}],"pairs":{"usd":[{"code":"USDCAD","dots":["up","up","up"]}]},"narrative":{"themes":[...]}}

REMEMBER: Start with { and end with }. No markdown. No explanations. Only JSON.`;

function pruneForPrompt(data) {
  // Trim history to keep the prompt small; the LLM only needs recent context.
  const clone = JSON.parse(JSON.stringify(data));
  for (const c of clone.currencies) {
    if (c.scoreHistory) c.scoreHistory = c.scoreHistory.slice(-3);
  }
  return clone;
}

function extractJson(text) {
  try {
    // Try direct JSON parse first
    return JSON.parse(text.trim());
  } catch (e) {
    // Remove markdown code blocks if present
    let trimmed = text.trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '');
    
    // Find first { and last }
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    
    if (firstBrace === -1 || lastBrace === -1) {
      throw new Error('No JSON object found in LLM response');
    }
    
    const jsonStr = trimmed.slice(firstBrace, lastBrace + 1);
    
    try {
      return JSON.parse(jsonStr);
    } catch (parseErr) {
      // Try to fix common issues
      let fixed = jsonStr;
      
      // Fix unescaped newlines in strings
      fixed = fixed.replace(/[\n\r]/g, ' ');
      
      // Fix missing commas between array elements
      fixed = fixed.replace(/\]\s*\[/g, '],[');
      fixed = fixed.replace(/\}\s*\{/g, '},{');
      
      // Try parsing again
      try {
        return JSON.parse(fixed);
      } catch (err2) {
        throw new Error(`Failed to parse JSON after fix attempts at position ${e.message}`);
      }
    }
  }
}

async function main() {
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const today = new Date();
  const isFriday = today.getUTCDay() === 5; // COT / weekly research day
  const dateLabel = today.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

  const promptData = pruneForPrompt(data);
  const userMsg = `Hôm nay là ${dateLabel} (giờ Việt Nam). ${isFriday ? 'Hôm nay là thứ Sáu — hãy kiểm tra và cập nhật object "cot" nếu có dữ liệu Tradingster mới.' : 'Hãy kiểm tra tin tức vĩ mô 24-48h gần nhất.'}

Dữ liệu dashboard hiện tại (giá đã được cập nhật tự động từ FMP, bạn không cần tự tính lại giá FX):
${JSON.stringify(promptData)}

Hãy tìm tin tức vĩ mô mới nhất (nếu có web_search) cho USD, EUR, JPY, GBP, CHF, CAD, AUD, NZD trong 24-48h qua.

OUTPUT ONLY THE JSON PATCH OBJECT. NO TEXT BEFORE OR AFTER. START WITH { END WITH }.`;

  const useWebSearch = process.env.ENABLE_WEB_SEARCH === 'true' || isFriday;

  let patch = {};
  try {
    const raw = await callLLM({
      system: SYSTEM_PROMPT,
      user: userMsg,
      maxTokens: 8000,
      useWebSearch,
    });

    console.log('[LLM Response Length]', raw.length, 'chars');
    console.log('[LLM Response Start]', raw.slice(0, 100));

    try {
      patch = extractJson(raw);
      console.log('[LLM Patch Extracted]', Object.keys(patch).length === 0 ? 'empty patch' : 'keys: ' + Object.keys(patch).join(', '));
    } catch (parseErr) {
      console.error('[JSON Parse Failed]', parseErr.message);
      console.error('[Response Preview]', raw.slice(0, 1000));
      console.warn('LLM returned invalid JSON, using empty patch (dashboard unchanged).');
      patch = {};
    }
  } catch (llmErr) {
    console.error('[LLM Call Failed]', llmErr.message);
    console.warn('LLM provider error, using empty patch (dashboard unchanged).');
    patch = {};
  }

  if (Object.keys(patch).length === 0) {
    console.log('[Result] No macro-relevant changes detected or empty patch received.');
    console.log('[Dashboard] Updating only meta.updatedAt timestamp.');
    data.meta.updatedAt = new Date().toISOString();
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
  } else {
    try {
      const merged = applyPatch(data, patch);
      merged.meta.dateLabel = dateLabel;
      merged.meta.updatedAt = new Date().toISOString();
      fs.writeFileSync(dataPath, JSON.stringify(merged, null, 2));
      console.log('[Result] Patch applied successfully with keys:', Object.keys(patch).join(', '));
      console.log('[Currencies Updated]', patch.currencies ? patch.currencies.map(c => c.code).join(', ') : 'none');
    } catch (mergeErr) {
      console.error('[Patch Apply Failed]', mergeErr.message);
      console.warn('Failed to apply patch, leaving dashboard.json unchanged except timestamp.');
      data.meta.updatedAt = new Date().toISOString();
      fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
    }
  }
}

main().catch(e => {
  console.error('[FATAL]', e.message);
  // Don't exit with error - allow workflow to continue
  console.warn('Workflow continuing despite llm-update error.');
  process.exit(0);
});
