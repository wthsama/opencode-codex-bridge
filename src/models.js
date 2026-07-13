const https = require("https");
const { HttpsProxyAgent } = require("https-proxy-agent");

const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
const CLIENT_VERSION = "1.0.0";
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || "http://127.0.0.1:7890";
const sharedAgent = new HttpsProxyAgent(PROXY);

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    let body = "";
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: "GET",
      headers: { ...headers, "Host": u.hostname },
      timeout: 30000,
      agent: sharedAgent,
      servername: u.hostname,
    }, (res) => {
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        const ok = res.statusCode >= 200 && res.statusCode < 400;
        resolve({ ok, status: res.statusCode, text: () => body, json: () => JSON.parse(body) });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    req.end();
  });
}

async function fetchModels(accessToken, accountId) {
  const resp = await httpsGet(`${CODEX_MODELS_URL}?client_version=${CLIENT_VERSION}`, {
    Authorization: `Bearer ${accessToken}`,
    "ChatGPT-Account-Id": accountId,
    originator: "opencode-codex-bridge",
  });
  if (!resp.ok) {
    throw new Error(`Failed to fetch models: ${resp.status} ${resp.text()}`);
  }
  return normalizeModelList(resp.json());
}

function normalizeModelList(raw) {
  let entries = raw?.data || raw?.models || raw?.items || [];
  if (!Array.isArray(entries)) entries = [];
  const models = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      models.push({ id: entry, owned_by: "codex" });
    } else if (entry.slug || entry.id || entry.model || entry.name) {
      models.push({
        id: entry.slug || entry.id || entry.model || entry.name,
        owned_by: entry.owned_by || entry.ownedBy || entry.provider || "codex",
      });
    }
  }
  return { object: "list", data: models };
}

module.exports = { fetchModels };
