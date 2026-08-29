const express = require("express");
const { runLoginFlow, getValidAccessToken, readAuth } = require("./auth");
const { fetchModels, fetchQuota } = require("./models");
const { proxyResponses } = require("./proxy");
const { syncModels } = require("./sync");
const { getFastMode, setFastMode } = require("./settings");

const PORT = 15722;
const STATUS_LABELS = {
  idle: "未同步",
  starting: "启动中",
  syncing: "同步中",
  ready: "就绪",
  degraded: "降级运行",
  unauthenticated: "未登录",
  no_config: "配置缺失",
};

let syncState = { status: "idle", modelCount: 0, models: [], error: null, lastSync: null };
let quotaState = { status: "idle", quota: null, error: null, lastFetch: null };

async function doSync() {
  try {
    syncState = { status: "syncing", modelCount: 0, models: [], error: null, lastSync: syncState.lastSync };
    const result = await syncModels();
    syncState = {
      status: result.status,
      modelCount: result.modelCount || 0,
      models: result.models || [],
      error: result.status === "no_config" ? `找不到配置文件: ${result.path}` : null,
      lastSync: new Date().toISOString(),
    };
  } catch (e) {
    syncState = {
      status: "degraded",
      modelCount: syncState.modelCount,
      models: syncState.models,
      error: e.message,
      lastSync: syncState.lastSync,
    };
  }
  return syncState;
}

async function refreshQuota(quotaFetcher = fetchQuota, authGetter = getValidAccessToken) {
  quotaState = { ...quotaState, status: "loading", error: null };
  try {
    const auth = await authGetter();
    if (!auth) {
      quotaState = { status: "unauthenticated", quota: null, error: "请先登录", lastFetch: null };
      return quotaState;
    }

    quotaState = {
      status: "ready",
      quota: await quotaFetcher(auth.access_token, auth.account_id),
      error: null,
      lastFetch: new Date().toISOString(),
    };
  } catch (e) {
    quotaState = { ...quotaState, status: "error", error: e.message };
  }
  return quotaState;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDate(value) {
  if (!value) return "未知";
  const date = typeof value === "number"
    ? new Date(value > 100000000000 ? value : value * 1000)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? "未知" : date.toLocaleString();
}

function windowLabel(window) {
  if (window.limitWindowSeconds === 18000) return "5 小时额度";
  if (window.limitWindowSeconds === 604800) return "7 天额度";
  if (window.limitWindowSeconds) return `${Math.round(window.limitWindowSeconds / 3600)} 小时额度`;
  return "额度窗口";
}

function quotaWindowMarkup(window) {
  const used = window.usedPercent === null ? "暂无" : `${window.usedPercent}%`;
  const remaining = window.remainingPercent === null ? "暂无" : `${window.remainingPercent}%`;
  const progress = window.usedPercent === null ? 0 : Math.min(100, Math.max(0, window.usedPercent));
  return `<div class="quota-window">
    <div class="quota-window-head"><strong>${windowLabel(window)}</strong><span>${remaining} 剩余</span></div>
    <div class="progress"><span style="width:${progress}%"></span></div>
    <div class="quota-meta"><span>已使用 ${used}</span><span>重置于 ${escapeHtml(formatDate(window.resetAt))}</span></div>
  </div>`;
}

function quotaMarkup(loggedIn) {
  if (!loggedIn) {
    return `<div class="empty-state">登录后点击“刷新额度”查看官方用量。</div>`;
  }
  if (!quotaState.quota) {
    const message = quotaState.status === "error" ? quotaState.error : "点击按钮获取最新额度";
    return `<div class="empty-state">${escapeHtml(message || "暂无数据")}</div>`;
  }

  const windows = [quotaState.quota.primary, quotaState.quota.secondary].filter(Boolean);
  return `${quotaState.quota.planType ? `<div class="plan">当前方案 <strong>${escapeHtml(quotaState.quota.planType)}</strong></div>` : ""}
    ${windows.length ? `<div class="quota-grid">${windows.map(quotaWindowMarkup).join("")}</div>` : '<div class="empty-state">暂无额度窗口数据</div>'}
    ${quotaState.error ? `<div class="inline-error">${escapeHtml(quotaState.error)}</div>` : ""}`;
}

function createApp({ sync = doSync, quotaFetcher = fetchQuota, authGetter = getValidAccessToken } = {}) {
  const app = express();
  app.use(express.json({ limit: "50mb" }));

  app.get("/", (_req, res) => {
    const auth = readAuth();
    const loggedIn = !!(auth && auth.account_id);
    const fm = getFastMode();
    const st = syncState;
    const syncBadgeClass = st.status === "ready" ? "badge-ok" : st.status === "degraded" ? "badge-warn" : "badge-muted";
    const page = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenCode Codex Bridge</title>
<style>
:root{color-scheme:light;--ink:#182230;--muted:#6b7788;--line:#e7ebf1;--blue:#4f68e8;--blue-dark:#3851d2;--soft:#f6f8fc}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:linear-gradient(145deg,#f7f9fc 0%,#fff 55%,#f2f5ff 100%);font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink)}main{width:min(760px,100%);margin:0 auto;padding:48px 20px 64px}.eyebrow{margin:0 0 10px;color:var(--blue);font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}h1{margin:0;font-size:clamp(28px,5vw,42px);letter-spacing:-.04em}h1+p{margin:10px 0 32px;color:var(--muted);font-size:15px}.section{margin-top:28px}.section-title{display:flex;align-items:baseline;justify-content:space-between;margin:0 0 10px}.section-title h2{margin:0;font-size:14px;letter-spacing:.08em;text-transform:uppercase}.section-title p{margin:0;color:var(--muted);font-size:12px}.card{padding:20px;background:rgba(255,255,255,.88);border:1px solid var(--line);border-radius:18px;box-shadow:0 10px 30px rgba(43,58,91,.06)}.row{display:flex;align-items:center;justify-content:space-between;gap:16px}.row+.row{margin-top:14px}.label{color:var(--muted);font-size:14px}.value{font-weight:700;text-align:right;overflow-wrap:anywhere}.badge{padding:5px 10px;border-radius:999px;font-size:12px;font-weight:750}.badge-ok{background:#e7f8ef;color:#18804b}.badge-warn{background:#fff4df;color:#a86700}.badge-muted{background:#eef1f6;color:#687486}.btn{border:0;border-radius:10px;padding:10px 15px;background:var(--blue);color:#fff;font:inherit;font-size:13px;font-weight:700;cursor:pointer;transition:.18s ease}.btn:hover{background:var(--blue-dark);transform:translateY(-1px)}.btn:disabled{opacity:.55;cursor:wait;transform:none}.subtle{margin:4px 0 0;color:var(--muted);font-size:12px}.toggle{position:relative;width:48px;height:28px;padding:0;border:0;border-radius:20px;background:#cfd6e2;cursor:pointer;transition:.2s}.toggle:after{content:"";position:absolute;top:4px;left:4px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.15);transition:.2s}.toggle.on{background:var(--blue)}.toggle.on:after{left:24px}.empty-state{padding:12px 0;color:var(--muted);font-size:14px}.inline-error{margin-top:14px;padding:10px 12px;border-radius:10px;background:#fff1f1;color:#b33a3a;font-size:13px}.plan{margin-bottom:16px;color:var(--muted);font-size:13px}.plan strong{color:var(--ink)}.quota-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.quota-window{padding:15px;background:var(--soft);border-radius:14px}.quota-window-head,.quota-meta{display:flex;justify-content:space-between;gap:10px}.quota-window-head{font-size:13px}.quota-window-head span,.quota-meta{color:var(--muted)}.quota-meta{margin-top:9px;font-size:11px}.progress{height:8px;margin-top:14px;overflow:hidden;border-radius:8px;background:#e3e8f0}.progress span{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#61b7f4,var(--blue))}.model-list{margin-top:16px;display:flex;flex-wrap:wrap;gap:7px}.model{padding:5px 9px;border:1px solid var(--line);border-radius:8px;background:var(--soft);color:#526074;font-size:11px}
 main{width:min(760px,100%)}.dashboard{display:grid;grid-template-columns:1fr;gap:18px}.dashboard .section{margin-top:0}.dashboard .card{background:#eef1f6}.dashboard .quota-window{background:#f8f9fb}
 @media(max-width:560px){main{padding:32px 16px 48px}.dashboard{grid-template-columns:1fr}.card{padding:16px;border-radius:15px}.quota-grid{grid-template-columns:1fr}.section-title{align-items:flex-start;gap:10px;flex-direction:column}}
</style></head><body><main>
<p class="eyebrow">Local control center</p><h1>OpenCode Codex Bridge</h1><p>本地中转服务状态与额度控制台</p>
<div class="dashboard">
<section class="section"><div class="section-title"><h2>账户</h2></div><div class="card"><div class="row"><span class="label">登录状态</span><span class="badge ${loggedIn ? "badge-ok" : "badge-warn"}">${loggedIn ? "已登录" : "未登录"}</span></div>
${loggedIn ? `<div class="row"><span class="label">账号</span><span class="value">${escapeHtml(auth.email || auth.account_id)}</span></div>` : '<form action="/login" method="POST"><button class="btn" type="submit">浏览器登录</button></form>'}</div></section>
<section class="section"><div class="section-title"><h2>额度</h2><p>${quotaState.lastFetch ? `更新于 ${escapeHtml(formatDate(quotaState.lastFetch))}` : "官方用量接口"}</p></div><div class="card">${quotaMarkup(loggedIn)}${loggedIn ? '<button class="btn action-btn" data-action="/quota" type="button">刷新额度</button>' : ""}</div></section>
<section class="section"><div class="section-title"><h2>Fast 模式</h2><p>约 1.5x 额度消耗</p></div><div class="card"><div class="row"><div><div class="label">优先级请求</div><p class="subtle">开启后使用 priority service tier</p></div><button class="toggle ${fm ? "on" : ""}" id="fastBtn" aria-label="切换 Fast 模式" aria-pressed="${fm}" type="button"></button></div></div></section>
<section class="section"><div class="section-title"><h2>模型同步</h2><p>默认不自动触发</p></div><div class="card"><div class="row"><span class="label">状态</span><span class="badge ${syncBadgeClass}">${STATUS_LABELS[st.status] || escapeHtml(st.status)}</span></div>
${st.modelCount ? `<div class="row"><span class="label">模型数量</span><span class="value">${st.modelCount}</span></div>` : ""}${st.lastSync ? `<div class="row"><span class="label">上次同步</span><span class="value">${escapeHtml(formatDate(st.lastSync))}</span></div>` : ""}${st.error ? `<div class="inline-error">${escapeHtml(st.error)}</div>` : ""}
<button class="btn action-btn" data-action="/sync" type="button" ${st.status === "syncing" ? "disabled" : ""}>${st.status === "syncing" ? "同步中..." : "点击同步模型"}</button>${st.models.length ? `<div class="model-list">${st.models.map(model => `<span class="model">${escapeHtml(model)}</span>`).join("")}</div>` : ""}</div></section>
</div>
<script>
async function postAction(path, button){const original=button.textContent;button.disabled=true;button.textContent="处理中...";try{const response=await fetch(path,{method:"POST"});if(!response.ok)throw new Error("请求失败");window.location.reload()}catch(error){button.disabled=false;button.textContent=original;alert(error.message)}}
document.querySelectorAll(".action-btn").forEach(button=>button.addEventListener("click",()=>postAction(button.dataset.action,button)));
document.getElementById("fastBtn").addEventListener("click",async()=>{const button=document.getElementById("fastBtn");button.disabled=true;try{const response=await fetch("/fast",{method:"POST"});const data=await response.json();button.classList.toggle("on",data.fast);button.setAttribute("aria-pressed",data.fast)}finally{button.disabled=false}});
</script></main></body></html>`;
    res.send(page);
  });

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.get("/status", (_req, res) => {
    const auth = readAuth();
    res.json({ authenticated: !!(auth && auth.account_id), account: auth ? (auth.email || auth.account_id) : null, fastMode: getFastMode(), sync: syncState, quota: quotaState });
  });

  app.get("/login/status", (_req, res) => {
    const auth = readAuth();
    if (auth && auth.account_id) return res.json({ authenticated: true, account_id: auth.account_id, email: auth.email });
    res.json({ authenticated: false });
  });

  app.post("/login", async (_req, res) => {
    try {
      const result = await runLoginFlow();
      res.json({ ok: true, account_id: result.account_id, email: result.email });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/fast", (_req, res) => res.json({ fast: getFastMode() }));

  app.post("/fast", (_req, res) => {
    const fast = !getFastMode();
    setFastMode(fast);
    res.json({ fast });
  });

  app.post("/sync", async (_req, res) => {
    await sync();
    res.json(syncState);
  });

  app.get("/quota", (_req, res) => res.json(quotaState));

  app.post("/quota", async (_req, res) => {
    res.json(await refreshQuota(quotaFetcher, authGetter));
  });

  app.get("/v1/models", async (_req, res) => {
    try {
      const auth = await getValidAccessToken();
      if (!auth) return res.status(401).json({ error: "not_authenticated", message: "Run POST /login first" });
      res.json(await fetchModels(auth.access_token, auth.account_id));
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
      if (!res.headersSent) res.status(502).json({ error: e.message });
    }
  });

  return app;
}

function startServer({ port = PORT, host = "127.0.0.1", syncOnStart = false, sync = doSync, quotaFetcher = fetchQuota, authGetter = getValidAccessToken, logger = console } = {}) {
  const server = createApp({ sync, quotaFetcher, authGetter }).listen(port, host, () => {
    logger.log(`OpenCode Codex 中转站 => http://${host}:${server.address().port}`);
    const auth = readAuth();
    logger.log(auth && auth.account_id ? `已登录: ${auth.email || auth.account_id}` : "未登录。运行: node src/cli-login.js");
    if (syncOnStart) {
      sync().then((state) => {
        if (state && state.status === "ready") logger.log(`已同步 ${state.modelCount} 个模型。重启 OpenCode 后生效。`);
      });
    }
  });
  return server;
}

if (require.main === module) startServer();

module.exports = { createApp, doSync, refreshQuota, startServer };
