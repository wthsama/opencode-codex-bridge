const https = require("https");
const { HttpsProxyAgent } = require("https-proxy-agent");

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || "http://127.0.0.1:7890";

function createAgent() {
  return new HttpsProxyAgent(PROXY);
}

function fetch(url, opts) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    let body = "";
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: opts?.method || "GET",
      headers: { ...(opts?.headers || {}), "Host": u.hostname },
      timeout: 30000,
      agent: createAgent(),
      servername: u.hostname,
    }, (res) => {
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ ok: res.statusCode < 400, status: res.statusCode, text, json }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    if (opts?.body) req.write(opts.body);
    req.end();

    function text() { return body; }
    function json() { return JSON.parse(body); }
  });
}

async function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function login() {
  console.log("Starting Codex OAuth login...\n");

  const deviceResp = await fetch("https://auth.openai.com/api/accounts/deviceauth/usercode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: "openid profile email" }),
  });
  if (!deviceResp.ok) {
    console.error("Failed to request device code:", deviceResp.text());
    process.exit(1);
  }
  const device = deviceResp.json();
  const verifyUrl = device.verification_uri || device.verification_uri_complete || "https://auth.openai.com/codex/device";
  console.log(`Please open this URL in your browser: ${verifyUrl}`);
  console.log(`Enter this code: ${device.user_code}\n`);
  console.log("Waiting for authorization...");

  let tokenResp;
  for (let i = 0; i < 60; i++) {
    await delay(5000);
    process.stdout.write(".");
    const pollResp = await fetch("https://auth.openai.com/api/accounts/deviceauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_auth_id: device.device_auth_id,
        user_code: device.user_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    let data;
    try { data = pollResp.json(); } catch { data = { error: { message: pollResp.text() } }; }
    if (data.error) {
      const errCode = typeof data.error === "string" ? data.error : (data.error.code || "");
      if (errCode === "authorization_pending" || errCode === "deviceauth_authorization_pending") continue;
      if (errCode === "slow_down") { i--; continue; }
      console.error(`\nLogin failed: ${JSON.stringify(data.error)}`);
      process.exit(1);
    }
    tokenResp = data;
    break;
  }
  if (!tokenResp) {
    console.error("\nLogin timed out (5 minutes).");
    process.exit(1);
  }
  console.log("\nAuthorized!");

  const exchangeResp = await fetch("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: tokenResp.authorization_code,
      client_id: CLIENT_ID,
      code_verifier: tokenResp.code_verifier,
      redirect_uri: "https://auth.openai.com/deviceauth/callback",
    }).toString(),
  });
  if (!exchangeResp.ok) {
    console.error("Token exchange failed:", exchangeResp.text());
    process.exit(1);
  }
  const tokens = exchangeResp.json();

  const idParts = tokens.id_token.split(".");
  const idClaims = JSON.parse(Buffer.from(idParts[1], "base64url").toString());
  const accountId = idClaims.chatgpt_account_id
    || idClaims.organizations?.[0]?.chatgpt_account_id
    || idClaims.org_id
    || idClaims.sub;
  const email = idClaims.email || "";

  const fs = require("fs");
  const path = require("path");
  const dataDir = path.join(__dirname, "..", "data");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const dataFile = path.join(dataDir, "auth.json");
  const authData = {
    account_id: accountId,
    email,
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    expires_at: Date.now() + (tokens.expires_in || 3600) * 1000 - 60000,
  };
  fs.writeFileSync(dataFile, JSON.stringify(authData, null, 2), "utf8");

  console.log(`\nLogin successful!`);
  console.log(`  Account: ${email || accountId}`);
  console.log(`  Token saved to ${dataFile}`);
  console.log(`\nYou can now start the proxy with: npm start`);
}

login().catch((e) => {
  console.error("Login error:", e.message);
  process.exit(1);
});
