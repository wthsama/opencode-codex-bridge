const fs = require("fs");
const path = require("path");
const https = require("https");
const { exec } = require("child_process");
const { getProxyAgent } = require("./settings");

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_CODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const DATA_FILE = path.join(__dirname, "..", "data", "auth.json");

function httpsFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const agent = getProxyAgent();
    let body = "";
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: opts.method || "GET",
      headers: { ...(opts.headers || {}), "Host": u.hostname },
      timeout: 30000,
      agent,
      servername: u.hostname,
    }, (res) => {
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        const ok = res.statusCode >= 200 && res.statusCode < 400;
        const status = res.statusCode;
        resolve({
          ok,
          status,
          text: () => body,
          json: () => JSON.parse(body),
        });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readAuth() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeAuth(data) {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

function parseJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

async function startDeviceFlow() {
  const resp = await httpsFetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: "openid profile email" }),
  });
  if (!resp.ok) {
    throw new Error(`Device code request failed: ${resp.status} ${resp.text()}`);
  }
  return resp.json();
}

async function pollForToken(device) {
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    const resp = await httpsFetch(DEVICE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_auth_id: device.device_auth_id,
        user_code: device.user_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const data = resp.json();
    if (data.error) {
      const errCode = typeof data.error === "string" ? data.error : (data.error.code || "");
      if (errCode === "authorization_pending" || errCode === "deviceauth_authorization_pending") continue;
      if (errCode === "slow_down") { i--; continue; }
      throw new Error(`Device flow failed: ${JSON.stringify(data.error)}`);
    }
    return data;
  }
  throw new Error("Device flow timed out after 5 minutes");
}

async function exchangeCodeForTokens(code, codeVerifier) {
  const resp = await httpsFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
      redirect_uri: "https://auth.openai.com/deviceauth/callback",
    }).toString(),
  });
  if (!resp.ok) {
    throw new Error(`Token exchange failed: ${resp.status} ${resp.text()}`);
  }
  return resp.json();
}

async function refreshAccessToken(refreshToken) {
  const resp = await httpsFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "opencode-codex-bridge" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      scope: "openid profile email",
    }).toString(),
  });
  if (!resp.ok) {
    throw new Error(`Token refresh failed: ${resp.status} ${resp.text()}`);
  }
  return resp.json();
}

let currentLoginSession = null;

function formatSessionForClient(s) {
  if (!s) return null;
  return {
    state: s.completed ? (s.status === "success" ? "completed" : "error") : (s.user_code ? "waiting_user" : "starting"),
    status: s.status,
    user_code: s.user_code,
    userCode: s.user_code,
    verification_uri: s.verification_uri,
    authUrl: s.verification_uri,
    error: s.error,
    completed: s.completed,
  };
}

function getLoginSession() {
  return formatSessionForClient(currentLoginSession);
}

function cancelLoginSession() {
  if (currentLoginSession && !currentLoginSession.completed) {
    currentLoginSession.aborted = true;
    currentLoginSession.status = "canceled";
    currentLoginSession.error = "Login canceled by user";
  }
}

async function startLoginSession() {
  if (currentLoginSession && !currentLoginSession.completed && !currentLoginSession.error) {
    return currentLoginSession;
  }

  const session = {
    user_code: null,
    verification_uri: null,
    expires_in: null,
    status: "starting", // starting -> pending_authorization -> success | error | canceled
    error: null,
    completed: false,
    started_at: Date.now(),
    aborted: false,
  };
  currentLoginSession = session;

  (async () => {
    try {
      const deviceResp = await startDeviceFlow();
      if (session.aborted) return;
      session.user_code = deviceResp.user_code;
      session.verification_uri = deviceResp.verification_uri || "https://auth.openai.com/codex/device";
      session.expires_in = deviceResp.expires_in || 300;
      session.status = "pending_authorization";

      // 尝试在本地操作系统中打开授权网页
      try {
        const targetUrl = session.verification_uri;
        if (process.platform === "win32") {
          exec(`start "" "${targetUrl}"`);
        } else if (process.platform === "darwin") {
          exec(`open "${targetUrl}"`);
        } else {
          exec(`xdg-open "${targetUrl}"`);
        }
      } catch {}

      // 轮询等待授权
      for (let i = 0; i < 60; i++) {
        if (session.aborted) return;
        await sleep(5000);
        if (session.aborted) return;

        const resp = await httpsFetch(DEVICE_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: CLIENT_ID,
            device_auth_id: deviceResp.device_auth_id,
            user_code: deviceResp.user_code,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }),
        });

        const data = resp.json();
        if (data.error) {
          const errCode = typeof data.error === "string" ? data.error : (data.error.code || "");
          if (errCode === "authorization_pending" || errCode === "deviceauth_authorization_pending") continue;
          if (errCode === "slow_down") { i--; continue; }
          throw new Error(`Device flow failed: ${typeof data.error === "string" ? data.error : JSON.stringify(data.error)}`);
        }

        // 成功获取到授权 code
        const tokens = await exchangeCodeForTokens(data.authorization_code, data.code_verifier);
        const idClaims = parseJwtPayload(tokens.id_token);
        const accountId = idClaims?.chatgpt_account_id
          || idClaims?.organizations?.[0]?.chatgpt_account_id
          || idClaims?.org_id
          || idClaims?.sub;
        const email = idClaims?.email || "";

        const authData = {
          account_id: accountId,
          email,
          refresh_token: tokens.refresh_token,
          access_token: tokens.access_token,
          expires_at: Date.now() + (tokens.expires_in || 3600) * 1000 - 60000,
        };
        writeAuth(authData);

        session.status = "success";
        session.completed = true;
        session.account = authData;
        return;
      }
      throw new Error("Device flow timed out after 5 minutes");
    } catch (err) {
      if (!session.aborted) {
        session.status = "error";
        session.completed = true;
        session.error = err.message || String(err);
      }
    }
  })();

  // 等待直到拿到 user_code 或者出现错误（最多等待10秒），以便首次返回就有验证码
  const startWait = Date.now();
  while (!session.user_code && !session.completed && !session.error && (Date.now() - startWait < 10000)) {
    await sleep(200);
  }

  return session;
}

async function runLoginFlow() {
  const session = await startLoginSession();
  while (!session.completed && !session.error && !session.aborted) {
    await sleep(1000);
  }
  if (session.error) throw new Error(session.error);
  return session.account;
}

async function getValidAccessToken() {
  let auth = readAuth();
  if (!auth) return null;
  if (auth.expires_at && Date.now() < auth.expires_at) return auth;
  const tokens = await refreshAccessToken(auth.refresh_token);
  const newRefreshToken = tokens.refresh_token || auth.refresh_token;
  auth = {
    ...auth,
    access_token: tokens.access_token,
    refresh_token: newRefreshToken,
    expires_at: Date.now() + (tokens.expires_in || 3600) * 1000 - 60000,
  };
  writeAuth(auth);
  return auth;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  runLoginFlow,
  startLoginSession,
  getLoginSession,
  cancelLoginSession,
  getValidAccessToken,
  readAuth,
};
