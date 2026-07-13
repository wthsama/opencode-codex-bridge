const https = require("https");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { getFastMode } = require("./settings");

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || "http://127.0.0.1:7890";
const sharedAgent = new HttpsProxyAgent(PROXY);

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

function getHeader(map, name) {
  const key = name.toLowerCase();
  for (const k of Object.keys(map)) {
    if (k.toLowerCase() === key) return map[k];
  }
  return undefined;
}

function isRetryableError(msg) {
  return /socket disconnected before secure TLS/i.test(msg)
    || /ECONNRESET/i.test(msg)
    || /socket hang up/i.test(msg)
    || /ETIMEDOUT/i.test(msg);
}

async function doRequest(options, bodyStr) {
  return new Promise((resolve, reject) => {
    const upstream = https.request(options, (upRes) => {
      resolve(upRes);
    });
    upstream.on("error", reject);
    upstream.on("timeout", () => { upstream.destroy(); reject(new Error("Request timeout")); });
    upstream.write(bodyStr);
    upstream.end();
  });
}

async function forwardWithRetry(options, bodyStr, maxRetries = 5) {
  let lastError;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await doRequest(options, bodyStr);
    } catch (e) {
      lastError = e;
      if (i < maxRetries && isRetryableError(e.message)) {
        const delay = Math.min(1000 * Math.pow(2, i), 10000);
        await new Promise(r => setTimeout(r, delay));
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

  return new Promise(async (resolve) => {
    const u = new URL(CODEX_RESPONSES_URL);
    const options = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "ChatGPT-Account-Id": accountId,
        originator: "opencode-codex-bridge",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
        Host: u.hostname,
      },
      timeout: 600000,
      agent: sharedAgent,
      servername: u.hostname,
    };

    let upRes;
    try {
      upRes = await forwardWithRetry(options, bodyStr);
    } catch (e) {
      if (!res.headersSent) res.status(502).json({ error: { message: `Upstream error: ${e.message}` } });
      return resolve();
    }

    const status = upRes.statusCode;
    const contentType = getHeader(upRes.headers, "content-type") || "";

    if (status >= 400) {
      let buf = "";
      upRes.on("data", (chunk) => (buf += chunk));
      upRes.on("end", () => {
        res.status(status).set("Content-Type", "application/json");
        try { res.send(JSON.stringify(JSON.parse(buf))); } catch { res.send(buf); }
        resolve();
      });
      return;
    }

    const isSse = contentType.includes("text/event-stream") || normalizedBody.stream;
    if (isSse) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();
      upRes.pipe(res);
      upRes.on("end", () => resolve());
    } else {
      let buf = "";
      upRes.on("data", (chunk) => (buf += chunk));
      upRes.on("end", () => {
        res.set("Content-Type", "application/json").send(buf);
        resolve();
      });
    }
  });
}

module.exports = { proxyResponses };
