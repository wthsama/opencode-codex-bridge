const express = require("express");
const { runLoginFlow, getValidAccessToken, readAuth } = require("./auth");
const { fetchModels } = require("./models");
const { proxyResponses } = require("./proxy");
const { syncModels } = require("./sync");
const { getFastMode, setFastMode } = require("./settings");

const app = express();
app.use(express.json({ limit: "50mb" }));

const STATUS_LABELS = { starting: "启动中", syncing: "同步中", ready: "就绪", degraded: "降级运行", unauthenticated: "未登录", no_config: "配置缺失" };

let syncState = { status: "starting", modelCount: 0, models: [], error: null, lastSync: null };

async function doSync() {
  try {
    syncState = { status: "syncing", modelCount: 0, models: [], error: null, lastSync: null };
    const result = await syncModels();
    syncState = {
      status: result.status,
      modelCount: result.modelCount || 0,
      models: result.models || [],
      error: result.status === "no_config" ? `找不到配置文件: ${result.path}` : null,
      lastSync: new Date().toISOString(),
    };
  } catch (e) {
    syncState = { status: "degraded", modelCount: syncState.modelCount, models: syncState.models, error: e.message, lastSync: syncState.lastSync };
  }
}

app.get("/", (_req, res) => {
  const auth = readAuth();
  const loggedIn = !!(auth && auth.account_id);
  const fm = getFastMode();
  const st = syncState;
  const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>OpenCode Codex Bridge</title>
<style>body{font-family:system-ui,sans-serif;max-width:600px;margin:40px auto;padding:0 16px;color:#e0e0e0;background:#1a1a2e}h1{color:#fff}h2{font-size:14px;color:#888;text-transform:uppercase;margin:24px 0 8px}.card{background:#16213e;border-radius:8px;padding:16px;margin:8px 0}.row{display:flex;justify-content:space-between;align-items:center}.label{color:#aaa}.value{font-weight:600}.badge{padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600}.badge-ok{background:#0f3460;color:#00ff88}.badge-warn{background:#3d2a00;color:#ffa500}.badge-err{background:#3d0000;color:#ff4444}.toggle{cursor:pointer;width:48px;height:26px;background:#444;border-radius:13px;position:relative;border:none;transition:background .2s}.toggle.on{background:#00ff88}.toggle::after{content:'';position:absolute;top:3px;left:3px;width:20px;height:20px;background:#fff;border-radius:50%;transition:left .2s}.toggle.on::after{left:25px}.btn{background:#0f3460;color:#fff;border:none;padding:8px 16px;border-radius:4px;cursor:pointer;font-size:14px;margin:8px 0}.btn:hover{background:#1a4a80}.btn:disabled{opacity:.5;cursor:default}</style></head><body>
<h1>OpenCode Codex 中转站</h1>
<h2>登录</h2>
<div class="card"><div class="row"><span class="label">状态</span><span class="badge ${loggedIn?'badge-ok':'badge-warn'}">${loggedIn?'已登录':'未登录'}</span></div>
${loggedIn?`<div class="row" style="margin-top:8px"><span class="label">账号</span><span class="value">${auth.email||auth.account_id}</span></div>`:'<form action="/login" method="POST"><button class="btn">浏览器登录</button></form>'}</div>
<h2>Fast 模式 <span style="font-size:12px;color:#ffa500">(约 1.5x 额度消耗)</span></h2>
<div class="card"><div class="row"><span class="label">状态</span><button class="toggle ${fm?'on':''}" id="fastBtn" onclick="toggleFast()"></button></div></div>
<h2>模型同步</h2>
<div class="card"><div class="row"><span class="label">状态</span><span class="badge ${st.status==='ready'?'badge-ok':st.status==='degraded'?'badge-warn':'badge-err'}">${STATUS_LABELS[st.status]||st.status}</span></div>
${st.modelCount?`<div class="row" style="margin-top:8px"><span class="label">模型数量</span><span class="value">${st.modelCount}</span></div>`:''}
${st.lastSync?`<div class="row" style="margin-top:8px"><span class="label">上次同步</span><span class="value">${new Date(st.lastSync).toLocaleString()}</span></div>`:''}
${st.error?`<div class="row" style="margin-top:8px"><span class="label">错误</span><span class="value" style="color:#ff4444">${st.error}</span></div>`:''}
<form action="/sync" method="POST"><button class="btn" ${st.status==='syncing'?'disabled':''}>重新同步</button></form></div>
<script>async function toggleFast(){const r=await fetch('/fast',{method:'POST'});const j=await r.json();document.getElementById('fastBtn').className='toggle '+(j.fast?'on':'')}</script>
</body></html>`;
  res.send(page);
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/status", (_req, res) => {
  const auth = readAuth();
  res.json({
    authenticated: !!(auth && auth.account_id),
    account: auth ? (auth.email || auth.account_id) : null,
    fastMode: getFastMode(),
    sync: syncState,
  });
});

app.get("/login/status", (_req, res) => {
  const auth = readAuth();
  if (auth && auth.account_id) {
    res.json({ authenticated: true, account_id: auth.account_id, email: auth.email });
  } else {
    res.json({ authenticated: false });
  }
});

app.post("/login", async (_req, res) => {
  try {
    const result = await runLoginFlow();
    res.json({ ok: true, account_id: result.account_id, email: result.email });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/fast", (_req, res) => {
  res.json({ fast: getFastMode() });
});

app.post("/fast", (_req, res) => {
  const current = getFastMode();
  setFastMode(!current);
  res.json({ fast: !current });
});

app.post("/sync", async (_req, res) => {
  await doSync();
  res.json(syncState);
});

app.get("/v1/models", async (_req, res) => {
  try {
    const auth = await getValidAccessToken();
    if (!auth) return res.status(401).json({ error: "not_authenticated", message: "Run POST /login first" });
    const models = await fetchModels(auth.access_token, auth.account_id);
    res.json(models);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post("/v1/responses", async (req, res) => {
  try {
    const auth = await getValidAccessToken();
    if (!auth) return res.status(401).json({ error: "not_authenticated", message: "Run POST /login first" });
    await proxyResponses(req, res, auth.access_token, auth.account_id);
  } catch (e) {
    if (!res.headersSent) {
      res.status(502).json({ error: e.message });
    }
  }
});

const PORT = 15722;
app.listen(PORT, "127.0.0.1", () => {
  console.log(`OpenCode Codex 中转站 => http://127.0.0.1:${PORT}`);
  const auth = readAuth();
  if (auth && auth.account_id) {
    console.log(`已登录: ${auth.email || auth.account_id}`);
  } else {
    console.log("未登录。运行: node src/cli-login.js");
  }
  doSync().then(() => {
    if (syncState.status === "ready") {
      console.log(`已同步 ${syncState.modelCount} 个模型。重启 OpenCode 后生效。`);
    }
  });
});
