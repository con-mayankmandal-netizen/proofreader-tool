// Model adapters. One provider per deployment, chosen by MODEL_PROVIDER;
// keys come from environment variables only (server-side, never in code).
// Each adapter returns the model's raw text; the caller extracts the JSON.

export function providerConfig() {
  const provider = (process.env.MODEL_PROVIDER || "mistral").toLowerCase();
  const conf = {
    mistral: {
      key: process.env.MISTRAL_API_KEY,
      model: process.env.MISTRAL_MODEL || "mistral-large-latest",
    },
    claude: {
      key: process.env.CLAUDE_API_KEY,
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-5",
    },
    gemini: {
      key: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL || "gemini-2.5-pro",
    },
  }[provider];
  if (!conf) throw new Error(`Unknown MODEL_PROVIDER "${provider}" (use mistral, claude or gemini)`);
  return { provider, ...conf };
}

export function verificationConfig() {
  const provider = (process.env.VERIFICATION_PROVIDER || "").toLowerCase();
  if (!provider) return null;
  const key = {
    mistral: process.env.MISTRAL_API_KEY,
    claude: process.env.CLAUDE_API_KEY,
    gemini: process.env.GEMINI_API_KEY,
  }[provider];
  const model = {
    mistral: process.env.VERIFICATION_MODEL || process.env.MISTRAL_MODEL || "mistral-large-latest",
    claude: process.env.VERIFICATION_MODEL || process.env.CLAUDE_MODEL || "claude-sonnet-4-5",
    gemini: process.env.VERIFICATION_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-pro",
  }[provider];
  if (!key) return null;
  return { provider, key, model };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rate-limit handling (the standing rule for this tool: slow is fine,
// correct matters). A 429 or 5xx no longer fails the task on the spot: the
// same request is retried with growing waits, honouring Retry-After when
// the provider sends one. Only after all retries is the error thrown, in
// the same "Model API <status>: ..." shape as before.
const MAX_API_RETRIES = 5;

function retryDelayMs(res, attempt) {
  const ra = res?.headers?.get?.("retry-after");
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, 300000);
    const when = Date.parse(ra);
    if (Number.isFinite(when)) return Math.min(Math.max(when - Date.now(), 5000), 300000);
  }
  return Math.min(20000 * 2 ** attempt, 180000);
}

async function postJson(url, headers, body) {
  for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (attempt === MAX_API_RETRIES) throw e;
      const wait = Math.min(20000 * 2 ** attempt, 180000);
      console.log(`Model API network error (${e.message}); retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }
    const text = await res.text();
    if (res.ok) return JSON.parse(text);
    const err = new Error(`Model API ${res.status}: ${text.slice(0, 400)}`);
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === MAX_API_RETRIES) throw err;
    const wait = retryDelayMs(res, attempt);
    console.log(`Model API ${res.status} (rate limited or server error); retrying in ${Math.round(wait / 1000)}s`);
    await sleep(wait);
  }
  throw new Error("Model API request failed");
}

// Pacing: keep a minimum gap between model calls (default 8s, override with
// MODEL_MIN_INTERVAL_MS) so a block of episodes does not burst through a
// tier's per-minute rate limit.
const MIN_INTERVAL_MS = Math.max(0, Number(process.env.MODEL_MIN_INTERVAL_MS || 8000) || 0);
let nextCallSlot = 0;
async function paceModelCall() {
  if (!MIN_INTERVAL_MS) return;
  const now = Date.now();
  const wait = Math.max(0, nextCallSlot - now);
  nextCallSlot = Math.max(now, nextCallSlot) + MIN_INTERVAL_MS;
  if (wait) await sleep(wait);
}

export async function callModel({ provider, key, model }, system, user) {
  if (!key) throw new Error(`No API key configured for provider "${provider}"`);
  await paceModelCall();
  if (provider === "mistral") {
    const data = await postJson(
      "https://api.mistral.ai/v1/chat/completions",
      { Authorization: `Bearer ${key}` },
      {
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }
    );
    return data.choices?.[0]?.message?.content ?? "";
  }
  if (provider === "claude") {
    const data = await postJson(
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": key, "anthropic-version": "2023-06-01" },
      {
        model,
        max_tokens: 32000,
        temperature: 0,
        system,
        messages: [{ role: "user", content: user }],
      }
    );
    return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  }
  if (provider === "gemini") {
    const data = await postJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
      {},
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }
    );
    return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  }
  throw new Error(`Unknown provider "${provider}"`);
}

// Models sometimes wrap JSON in fences despite instructions; strip them.
export function extractJson(text) {
  let t = String(text).trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
  if (fence) t = fence[1];
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start > 0 || end < t.length - 1) {
    if (start === -1 || end === -1) throw new Error("Model output contains no JSON object");
    t = t.slice(start, end + 1);
  }
  return JSON.parse(t);
}
