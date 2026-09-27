// 统一的 HTTP 客户端：基于 undici 的 fetch，按需通过代理（dispatcher）出网。
// 此前 auth.js / models.js / cli-login.js 各自拷贝了一份 https.request 封装，
// 现合并为这一份，避免重复实现请求、超时与 JSON 解析。
const { fetch } = require("undici");
const { getProxyDispatcher } = require("./settings");

// 底层请求：返回原始 Response，供需要读取流（SSE）的调用方使用。
// timeout 只约束「拿到响应头」的耗时；流式响应体由调用方自行处理。
async function rawFetch(url, { method = "GET", headers = {}, body, timeout = 60000, signal } = {}) {
  const controller = signal ? null : new AbortController();
  const effectiveSignal = signal || controller.signal;
  const timer = !signal && timeout > 0
    ? setTimeout(() => controller.abort(), timeout)
    : null;
  try {
    return await fetch(url, {
      method,
      headers,
      body,
      signal: effectiveSignal,
      dispatcher: getProxyDispatcher(),
    });
  } catch (err) {
    if (err && (err.name === "AbortError" || err.name === "TimeoutError")) {
      throw new Error("Request timeout");
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 常规请求：读完响应体，返回与旧 https 封装一致的 { ok, status, text(), json() } 形状。
async function request(url, opts = {}) {
  const res = await rawFetch(url, opts);
  const text = await res.text();
  return {
    ok: res.status >= 200 && res.status < 400,
    status: res.status,
    headers: res.headers,
    text: () => text,
    json: () => JSON.parse(text),
  };
}

module.exports = { request, rawFetch };
