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

async function proxyResponses(req, res, accessToken, accountId) {
  const normalizedBody = normalizeBody(req.body);
  const bodyStr = JSON.stringify(normalizedBody);
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
  if (isSse) {
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
