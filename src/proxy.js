const { Readable } = require("stream");
const { getFastMode } = require("./settings");
const { rawFetch } = require("./http");

const CODEX_RESPONSES_URL = process.env.CODEX_RESPONSES_URL || "https://chatgpt.com/backend-api/codex/responses";
const MAX_RETRIES = 5;
const STREAM_TIMEOUT_MS = 600000;

function normalizeBody(body) {
  const b = { ...body };
  b.stream = true;
  b.store = false;
  if (!b.include || !b.include.includes("reasoning.encrypted_content")) {
    b.include = [...(b.include || []), "reasoning.encrypted_content"];
  }
  if (b.parallel_tool_calls === undefined) b.parallel_tool_calls = false;
  if (getFastMode()) b.service_tier = "priority";
  delete b.max_output_tokens;
  delete b.temperature;
  delete b.top_p;
  return b;
}

// fetch 的网络错误统一表现为 "fetch failed"，真正原因在 cause 上。
function errorText(err) {
  const cause = err && err.cause;
  return [err && err.message, cause && cause.message, cause && cause.code]
    .filter(Boolean)
    .join(" ");
}

function isRetryableError(text) {
  return /socket disconnected before secure TLS/i.test(text)
    || /ECONNRESET/i.test(text)
    || /socket hang up/i.test(text)
    || /ETIMEDOUT/i.test(text)
    || /timeout/i.test(text);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function requestUpstream(headers, bodyStr) {
  let lastError;
  for (let i = 0; i <= MAX_RETRIES; i++) {
    try {
      return await rawFetch(CODEX_RESPONSES_URL, {
        method: "POST",
        headers,
        body: bodyStr,
        timeout: STREAM_TIMEOUT_MS,
      });
    } catch (e) {
      lastError = e;
      if (i < MAX_RETRIES && isRetryableError(errorText(e))) {
        await sleep(Math.min(1000 * Math.pow(2, i), 10000));
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

// Codex 上游只回 SSE。非流式客户端（未显式 stream:true）拿到的 SSE 会被
// OpenAI SDK 当作字符串返回，调用方访问 .choices/.output 即报错。
// 这里把 SSE 聚合回单条 Responses JSON，保持流式客户端行为不变。
function collectCompletedResponse(sseText) {
  let completed = null;
  const deltas = [];
  for (const rawLine of sseText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let event;
    try { event = JSON.parse(payload); } catch { continue; }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      deltas.push(event.delta);
    }
    if (event.response && (event.type === "response.completed" || event.type === "response.done" || event.type === "response.incomplete")) {
      completed = event.response;
    }
  }
  if (completed) return completed;

  const fallbackId = `resp_${Date.now().toString(36)}`;
  return {
    id: fallbackId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: null,
    output: deltas.length
      ? [{
          type: "message",
          id: `msg_${Date.now().toString(36)}`,
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: deltas.join(""), annotations: [] }],
        }]
      : [],
    usage: null,
  };
}

async function proxyResponses(req, res, accessToken, accountId) {
  const clientStream = !!(req.body && req.body.stream === true);
  const normalizedBody = normalizeBody(req.body);
  const bodyStr = JSON.stringify(normalizedBody);
  console.log(`[codex-bridge] path=${req.originalUrl || req.url} model=${req.body && req.body.model} client_stream=${JSON.stringify(req.body && req.body.stream)}`);
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "ChatGPT-Account-Id": accountId,
    originator: "opencode-codex-bridge",
    "Content-Type": "application/json",
  };

  let upRes;
  try {
    upRes = await requestUpstream(headers, bodyStr);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: { message: `Upstream error: ${e.message}` } });
    return;
  }

  const status = upRes.status;
  const contentType = upRes.headers.get("content-type") || "";

  if (status >= 400) {
    const text = await upRes.text();
    res.status(status).set("Content-Type", "application/json");
    try { res.send(JSON.stringify(JSON.parse(text))); } catch { res.send(text); }
    return;
  }

  const isSse = contentType.includes("text/event-stream") || normalizedBody.stream;
  if (isSse && !clientStream) {
    const text = await upRes.text();
    const response = collectCompletedResponse(text);
    console.log(`[codex-bridge] buffered non-stream response (client_stream=false) bytes=${text.length}`);
    res.set("Content-Type", "application/json").send(JSON.stringify(response));
  } else if (isSse) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    const upstreamStream = Readable.fromWeb(upRes.body);
    upstreamStream.on("error", (err) => { res.destroy(err); });
    res.on("close", () => upstreamStream.destroy());
    upstreamStream.pipe(res);
  } else {
    const text = await upRes.text();
    res.set("Content-Type", "application/json").send(text);
  }
}

module.exports = { proxyResponses };
