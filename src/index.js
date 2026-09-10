const express = require("express");
const {
  runLoginFlow,
  startLoginSession,
  getLoginSession,
  cancelLoginSession,
  getValidAccessToken,
  readAuth,
} = require("./auth");
const { fetchModels, fetchQuota } = require("./models");
const { proxyResponses } = require("./proxy");
const { syncModels } = require("./sync");
const {
  getFastMode,
  setFastMode,
  getCustomProxy,
  setCustomProxy,
  getActiveProxyUrl,
} = require("./settings");

const PORT = parseInt(process.env.PORT || "15722", 10);
const HOST = process.env.HOST || "127.0.0.1";
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
    const customProxy = getCustomProxy();
    const activeProxy = getActiveProxyUrl();
    const syncBadgeClass = st.status === "ready" ? "badge-ok" : st.status === "degraded" ? "badge-warn" : "badge-muted";
    const page = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenCode Codex Bridge</title>
<style>
:root{color-scheme:light;--ink:#182230;--muted:#6b7788;--line:#e7ebf1;--blue:#4f68e8;--blue-dark:#3851d2;--soft:#f6f8fc;--danger:#dc2626}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:linear-gradient(145deg,#f7f9fc 0%,#fff 55%,#f2f5ff 100%);font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink)}main{width:min(760px,100%);margin:0 auto;padding:48px 20px 64px}
.header-wrap{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:32px}
.eyebrow{margin:0 0 10px;color:var(--blue);font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}
h1{margin:0;font-size:clamp(28px,5vw,40px);letter-spacing:-.04em}
h1+p{margin:10px 0 0;color:var(--muted);font-size:15px}
.gear-btn{background:rgba(255,255,255,.9);border:1px solid var(--line);border-radius:12px;width:44px;height:44px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:.2s;color:var(--ink);box-shadow:0 4px 12px rgba(43,58,91,.06);flex-shrink:0}
.gear-btn:hover{background:#fff;border-color:#cfd6e2;transform:rotate(45deg)}
.gear-btn svg{width:22px;height:22px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.section{margin-top:24px}
.section-title{display:flex;align-items:baseline;justify-content:space-between;margin:0 0 10px}
.section-title h2{margin:0;font-size:14px;letter-spacing:.08em;text-transform:uppercase}
.section-title p{margin:0;color:var(--muted);font-size:12px}
.card{padding:20px;background:rgba(255,255,255,.92);border:1px solid var(--line);border-radius:18px;box-shadow:0 10px 30px rgba(43,58,91,.06)}
.row{display:flex;align-items:center;justify-content:space-between;gap:16px}
.row+.row{margin-top:14px}
.label{color:var(--muted);font-size:14px}
.value{font-weight:700;text-align:right;overflow-wrap:anywhere}
.badge{padding:5px 10px;border-radius:999px;font-size:12px;font-weight:750}
.badge-ok{background:#e7f8ef;color:#18804b}
.badge-warn{background:#fff4df;color:#a86700}
.badge-muted{background:#eef1f6;color:#687486}
.btn{border:0;border-radius:10px;padding:10px 16px;background:var(--blue);color:#fff;font:inherit;font-size:13px;font-weight:700;cursor:pointer;transition:.18s ease;display:inline-flex;align-items:center;justify-content:center;gap:6px;text-decoration:none}
.btn:hover{background:var(--blue-dark);transform:translateY(-1px)}
.btn:disabled{opacity:.55;cursor:wait;transform:none}
.btn-secondary{background:#eef1f6;color:var(--ink)}
.btn-secondary:hover{background:#e2e6ee}
.btn-danger{background:var(--danger);color:#fff}
.subtle{margin:4px 0 0;color:var(--muted);font-size:12px}
.toggle{position:relative;width:48px;height:28px;padding:0;border:0;border-radius:20px;background:#cfd6e2;cursor:pointer;transition:.2s}
.toggle:after{content:"";position:absolute;top:4px;left:4px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.15);transition:.2s}
.toggle.on{background:var(--blue)}
.toggle.on:after{transform:translateX(20px)}
.model-list{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.model{padding:4px 9px;border-radius:8px;background:var(--soft);border:1px solid var(--line);font-size:12px}
.inline-error{margin-top:10px;color:#c62828;font-size:12px;line-height:1.4}
.quota-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-top:14px}
.quota-window{padding:14px;background:#f8f9fb;border-radius:14px;border:1px solid var(--line)}
.quota-window-head{display:flex;justify-content:space-between;font-size:13px;margin-bottom:8px}
.progress{height:8px;background:#e9edf3;border-radius:999px;overflow:hidden;margin:8px 0}
.progress span{display:block;height:100%;background:linear-gradient(90deg,var(--blue),#22c55e);border-radius:999px;transition:width .3s ease}
.quota-meta{display:flex;justify-content:space-between;color:var(--muted);font-size:11px}
.plan{font-size:13px;color:var(--muted);margin-bottom:10px}
.plan strong{color:var(--ink)}
.empty-state{color:var(--muted);font-size:13px;text-align:center;padding:12px 0}
.modal-mask{position:fixed;inset:0;background:rgba(15,23,42,.45);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:99;padding:16px;opacity:0;pointer-events:none;transition:.2s ease}
.modal-mask.active{opacity:1;pointer-events:auto}
.modal{background:#fff;width:min(480px,100%);border-radius:20px;padding:26px;box-shadow:0 20px 50px rgba(0,0,0,.15);border:1px solid var(--line);position:relative}
.modal h3{margin:0 0 8px;font-size:19px;letter-spacing:-.02em}
.modal p{margin:0 0 16px;color:var(--muted);font-size:13px;line-height:1.5}
.code-box{background:var(--soft);border:2px dashed #b9c7db;padding:14px;border-radius:12px;font-family:monospace;font-size:24px;letter-spacing:.2em;text-align:center;font-weight:800;color:var(--blue-dark);margin:14px 0;user-select:all}
.modal-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:20px}
.input-text{width:100%;padding:10px 14px;border:1px solid var(--line);border-radius:10px;font-size:13px;font-family:inherit;box-sizing:border-box;outline:none}
.input-text:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(79,104,232,.15)}
.helper-text{font-size:12px;color:var(--muted);margin-top:6px}
.tip-badge{display:inline-block;padding:2px 8px;background:#eef1f6;border-radius:6px;font-size:11px;font-family:monospace}
@media(max-width:560px){main{padding:32px 16px 48px}.card{padding:16px;border-radius:15px}.quota-grid{grid-template-columns:1fr}.section-title{align-items:flex-start;gap:6px;flex-direction:column}}
</style></head><body><main>
<div class="header-wrap">
  <div>
    <p class="eyebrow">Local control center</p>
    <h1>OpenCode Codex Bridge</h1>
    <p>本地中转服务状态与额度控制台</p>
  </div>
  <button class="gear-btn" id="openSettingsBtn" title="网络与代理设置" type="button">
    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
  </button>
</div>

<div class="dashboard">
<section class="section"><div class="section-title"><h2>账户</h2><p id="proxyIndicator">当前代理: ${escapeHtml(activeProxy || "直连 (无代理)")}</p></div><div class="card"><div class="row"><span class="label">登录状态</span><span class="badge ${loggedIn ? "badge-ok" : "badge-warn"}">${loggedIn ? "已登录" : "未登录"}</span></div>
${loggedIn ? `<div class="row"><span class="label">账号</span><span class="value">${escapeHtml(auth.email || auth.account_id)}</span></div><div class="row" style="margin-top:16px"><button class="btn btn-secondary" id="startLoginBtn" type="button">切换/重新登录</button></div>` : '<div class="row" style="margin-top:16px"><button class="btn" id="startLoginBtn" type="button">浏览器登录</button></div>'}</div></section>
<section class="section"><div class="section-title"><h2>额度</h2><p>${quotaState.lastFetch ? `更新于 ${escapeHtml(formatDate(quotaState.lastFetch))}` : "官方用量接口"}</p></div><div class="card">${quotaMarkup(loggedIn)}${loggedIn ? '<button class="btn action-btn" data-action="/quota" type="button">刷新额度</button>' : ""}</div></section>
<section class="section"><div class="section-title"><h2>Fast 模式</h2><p>约 1.5x 额度消耗</p></div><div class="card"><div class="row"><div><div class="label">优先级请求</div><p class="subtle">开启后使用 priority service tier</p></div><button class="toggle ${fm ? "on" : ""}" id="fastBtn" aria-label="切换 Fast 模式" aria-pressed="${fm}" type="button"></button></div></div></section>
<section class="section"><div class="section-title"><h2>模型同步</h2><p>默认不自动触发</p></div><div class="card"><div class="row"><span class="label">状态</span><span class="badge ${syncBadgeClass}">${STATUS_LABELS[st.status] || escapeHtml(st.status)}</span></div>
${st.modelCount ? `<div class="row"><span class="label">模型数量</span><span class="value">${st.modelCount}</span></div>` : ""}${st.lastSync ? `<div class="row"><span class="label">上次同步</span><span class="value">${escapeHtml(formatDate(st.lastSync))}</span></div>` : ""}${st.error ? `<div class="inline-error">${escapeHtml(st.error)}</div>` : ""}
<button class="btn action-btn" data-action="/sync" type="button" ${st.status === "syncing" ? "disabled" : ""}>${st.status === "syncing" ? "同步中..." : "点击同步模型"}</button>${st.models.length ? `<div class="model-list">${st.models.map(model => `<span class="model">${escapeHtml(model)}</span>`).join("")}</div>` : ""}</div></section>
</div>

<!-- 登录弹窗 -->
<div class="modal-mask" id="loginModal">
  <div class="modal">
    <h3>ChatGPT OAuth 登录</h3>
    <p id="loginPrompt">正在请求授权码，请稍候...</p>
    <div id="loginCodeArea" style="display:none">
      <p style="margin-bottom:6px">请复制以下验证码并在弹出的浏览器页面中填入：</p>
      <div class="code-box" id="userCodeBox">----</div>
      <div class="row" style="justify-content:center;margin:10px 0 16px">
        <a class="btn" id="openAuthUrlBtn" href="#" target="_blank">手动打开授权页面</a>
      </div>
      <p class="subtle" style="text-align:center">验证完成后此窗口会自动关闭并刷新</p>
    </div>
    <div id="loginStatusArea" style="display:none" class="inline-error"></div>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="cancelLoginBtn" type="button">取消</button>
    </div>
  </div>
</div>

    <!-- 设置弹窗（齿轮） -->
    <div class="modal-mask" id="settingsModal">
      <div class="modal">
        <h3>网络与代理热设置</h3>
        <p id="settingsTipText">设置后立即对所有请求生效，无需重启服务。</p>
        <div style="margin-bottom:14px">
          <label class="label" style="display:block;margin-bottom:6px" for="proxyInput">代理服务器地址 (HTTP / HTTPS)</label>
          <input class="input-text" id="proxyInput" placeholder="例如 http://127.0.0.1:7890 或 direct" value="${escapeHtml(customProxy || "")}">
          <p class="helper-text">若国内环境无法直连 OpenAI，请配置代理端口（如 Clash: <span class="tip-badge">http://127.0.0.1:7890</span>，v2ray: <span class="tip-badge">http://127.0.0.1:10809</span>）；海外用户可填写 <span class="tip-badge">direct</span> 直连。</p>
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" id="closeSettingsBtn" type="button">关闭</button>
          <button class="btn" id="saveProxyBtn" type="button">保存并应用</button>
        </div>
      </div>
    </div>

<script>
async function postAction(path, button){const original=button.textContent;button.disabled=true;button.textContent="处理中...";try{const response=await fetch(path,{method:"POST"});if(!response.ok)throw new Error("请求失败");window.location.reload()}catch(error){button.disabled=false;button.textContent=original;alert(error.message)}}
document.querySelectorAll(".action-btn").forEach(button=>button.addEventListener("click",()=>postAction(button.dataset.action,button)));
document.getElementById("fastBtn").addEventListener("click",async()=>{const button=document.getElementById("fastBtn");button.disabled=true;try{const response=await fetch("/fast",{method:"POST"});const data=await response.json();button.classList.toggle("on",data.fast);button.setAttribute("aria-pressed",data.fast)}finally{button.disabled=false}});

// 齿轮设置交互
const settingsModal=document.getElementById("settingsModal");
const initialCustomProxy = ${JSON.stringify(customProxy || "")};
if (!initialCustomProxy || !initialCustomProxy.trim()) {
  document.getElementById("settingsTipText").textContent = "首次运行检测到尚未配置网络代理。如处于国内环境，请先设置代理端口；如免代理请填 direct。";
  settingsModal.classList.add("active");
}

document.getElementById("openSettingsBtn").addEventListener("click",()=>{
  document.getElementById("settingsTipText").textContent = "设置后立即对所有请求生效，无需重启服务。";
  settingsModal.classList.add("active");
});
document.getElementById("closeSettingsBtn").addEventListener("click",()=>{
  const currentVal = document.getElementById("proxyInput").value.trim();
  if(!currentVal){
    alert("请先填写代理地址（如 http://127.0.0.1:7890）或填写 direct 直连，保存后方可正常使用。");
    return;
  }
  settingsModal.classList.remove("active");
});
document.getElementById("saveProxyBtn").addEventListener("click",async()=>{
  const btn=document.getElementById("saveProxyBtn");
  const val=document.getElementById("proxyInput").value.trim();
  if(!val){
    alert("代理设置不能为空，请填写代理地址（例如 http://127.0.0.1:7890）或 direct（直连）");
    return;
  }
  btn.disabled=true;
  try{
    const res=await fetch("/settings/proxy",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({proxy:val})});
    const data=await res.json();
    if(!res.ok)throw new Error(data.error||"保存失败");
    document.getElementById("proxyIndicator").textContent="当前代理: "+(data.activeProxy||"直连 (无代理)");
    settingsModal.classList.remove("active");
  }catch(e){
    alert("设置失败: "+e.message);
  }finally{
    btn.disabled=false;
  }
});

// 登录交互
const loginModal=document.getElementById("loginModal");
let pollTimer=null;
function stopPolling(){if(pollTimer){clearInterval(pollTimer);pollTimer=null;}}

async function pollLoginSession(){
  try{
    const res=await fetch("/login/session");
    const s=await res.json();
    if(s.state==="completed"){
      stopPolling();
      loginModal.classList.remove("active");
      window.location.reload();
      return;
    }
    if(s.state==="error"){
      stopPolling();
      document.getElementById("loginStatusArea").style.display="block";
      document.getElementById("loginStatusArea").textContent="登录失败: "+(s.error||"未知错误");
      return;
    }
    if(s.state==="waiting_user" && s.userCode){
      document.getElementById("loginPrompt").textContent="请完成浏览器验证授权：";
      document.getElementById("userCodeBox").textContent=s.userCode;
      document.getElementById("openAuthUrlBtn").href=s.authUrl;
      document.getElementById("loginCodeArea").style.display="block";
    }
  }catch(e){
    console.error("轮询登录状态出错",e);
  }
}

document.getElementById("startLoginBtn").addEventListener("click",async()=>{
  const btn=document.getElementById("startLoginBtn");
  btn.disabled=true;
  loginModal.classList.add("active");
  document.getElementById("loginPrompt").textContent="正在请求授权码，请稍候...";
  document.getElementById("loginCodeArea").style.display="none";
  document.getElementById("loginStatusArea").style.display="none";
  try{
    const res=await fetch("/login/start",{method:"POST"});
    const data=await res.json();
    if(!res.ok)throw new Error(data.error||"初始化登录失败");
    if(data.userCode){
      document.getElementById("loginPrompt").textContent="请完成浏览器验证授权：";
      document.getElementById("userCodeBox").textContent=data.userCode;
      document.getElementById("openAuthUrlBtn").href=data.authUrl;
      document.getElementById("loginCodeArea").style.display="block";
    }
    stopPolling();
    pollTimer=setInterval(pollLoginSession,2000);
  }catch(e){
    document.getElementById("loginStatusArea").style.display="block";
    document.getElementById("loginStatusArea").textContent="登录启动失败: "+e.message;
  }finally{
    btn.disabled=false;
  }
});

document.getElementById("cancelLoginBtn").addEventListener("click",async()=>{
  stopPolling();
  await fetch("/login/cancel",{method:"POST"}).catch(()=>{});
  loginModal.classList.remove("active");
});
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

  app.get("/login/session", (_req, res) => {
    res.json(getLoginSession());
  });

  app.post("/login/start", async (_req, res) => {
    try {
      const session = await startLoginSession();
      res.json(getLoginSession() || session);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/login/cancel", (_req, res) => {
    cancelLoginSession();
    res.json({ ok: true });
  });

  app.post("/login", async (_req, res) => {
    try {
      const result = await runLoginFlow();
      res.json({ ok: true, account_id: result.account_id, email: result.email });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/settings/proxy", (_req, res) => {
    res.json({
      customProxy: getCustomProxy(),
      activeProxy: getActiveProxyUrl(),
    });
  });

  app.post("/settings/proxy", (req, res) => {
    const { proxy } = req.body || {};
    try {
      setCustomProxy(proxy);
      res.json({
        ok: true,
        customProxy: getCustomProxy(),
        activeProxy: getActiveProxyUrl(),
      });
    } catch (e) {
      res.status(400).json({ error: e.message });
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

function startServer({ port = PORT, host = HOST, syncOnStart = false, sync = doSync, quotaFetcher = fetchQuota, authGetter = getValidAccessToken, logger = console } = {}) {
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
