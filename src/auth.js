const fs = require("fs");
const path = require("path");
const https = require("https");
const { HttpsProxyAgent } = require("https-proxy-agent");

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_CODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const DATA_FILE = path.join(__dirname, "..", "data", "auth.json");
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || "http://127.0.0.1:7890";
const sharedAgent = new HttpsProxyAgent(PROXY);

function httpsFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    let body = "";
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: opts.method || "GET",
      headers: { ...(opts.headers || {}), "Host": u.hostname },
      timeout: 30000,
      agent: sharedAgent,
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

async function runLoginFlow() {
  const deviceResp = await startDeviceFlow();
  const tokenResp = await pollForToken(deviceResp);
  const tokens = await exchangeCodeForTokens(tokenResp.authorization_code, tokenResp.code_verifier);
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
  return authData;
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

module.exports = { runLoginFlow, getValidAccessToken, readAuth };
