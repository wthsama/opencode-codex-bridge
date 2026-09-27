// 烟雾测试：不依赖任何测试框架，断言失败即非零退出。
// 覆盖：HTTP 客户端（正常/404/超时/无代理）、app 路由、/v1/responses 的 SSE 转发。
const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");

async function main() {
  // 本地假上游
  const upstream = http.createServer((req, res) => {
    if (req.url === "/slow") { setTimeout(() => { res.writeHead(200); res.end("late"); }, 500); return; }
    if (req.url === "/sse") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"response.output_text.delta","delta":"hello"}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    if (req.url === "/nope") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ method: req.method, body, url: req.url }));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const up = `http://127.0.0.1:${upstream.address().port}`;

  const { request } = require(path.join(ROOT, "src", "http"));

  const r = await request(`${up}/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: 1 }) });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.json(), { method: "POST", body: '{"a":1}', url: "/echo" });

  const nf = await request(`${up}/nope`);
  assert.strictEqual(nf.ok, false);
  assert.strictEqual(nf.status, 404);

  let timedOut = false;
  try { await request(`${up}/slow`, { timeout: 50 }); } catch (e) { timedOut = /timeout/i.test(e.message); }
  assert.strictEqual(timedOut, true, "应触发超时");

  const settings = require(path.join(ROOT, "src", "settings"));
  assert.strictEqual(settings.getProxyDispatcher(), undefined);
  assert.strictEqual(settings.getActiveProxyUrl(), "");

  // 造一份 auth，验证已登录路径
  const dataDir = path.join(ROOT, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "auth.json"), JSON.stringify({
    account_id: "acct_test", email: "t@example.com", access_token: "tok_test",
    refresh_token: "ref_test", expires_at: Date.now() + 3600 * 1000,
  }));
  process.env.CODEX_RESPONSES_URL = `${up}/sse`;

  const { createApp } = require(path.join(ROOT, "src", "index"));
  const app = createApp();
  const appServer = app.listen(0, "127.0.0.1");
  await new Promise((r) => appServer.once("listening", r));
  const base = `http://127.0.0.1:${appServer.address().port}`;

  assert.deepStrictEqual((await request(`${base}/health`)).json(), { status: "ok" });
  assert.strictEqual((await request(`${base}/status`)).json().authenticated, true);
  assert.strictEqual((await request(`${base}/fast`, { method: "POST" })).json().fast, true);
  assert.strictEqual((await request(`${base}/fast`, { method: "POST" })).json().fast, false);
  assert.ok((await request(`${base}/`)).text().includes("OpenCode Codex Bridge"));

  const sse = await request(`${base}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-5", input: "hi" }) });
  assert.strictEqual(sse.status, 200);
  assert.ok(sse.text().includes("response.output_text.delta"));
  assert.ok(sse.text().includes("[DONE]"));

  appServer.close();
  upstream.close();
  console.log("ALL TESTS PASSED");
}

main().catch((e) => { console.error("TEST FAILED:", e); process.exit(1); });
