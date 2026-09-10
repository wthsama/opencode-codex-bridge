const fs = require("fs");
const path = require("path");
const { HttpsProxyAgent } = require("https-proxy-agent");

const SETTINGS_FILE = path.join(__dirname, "..", "data", "settings.json");

let cachedAgent = undefined;
let cachedProxyUrl = undefined;

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeSettings(data) {
  const dir = path.dirname(SETTINGS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), "utf8");
}

function getFastMode() {
  return !!readSettings().fastMode;
}

function setFastMode(enabled) {
  const s = readSettings();
  s.fastMode = !!enabled;
  writeSettings(s);
}

function getProxyConfig() {
  const s = readSettings();
  if (typeof s.proxy === "string") {
    return s.proxy.trim();
  }
  // If not configured in settings.json, check environment variables; otherwise empty (direct connection)
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || "";
  return envProxy.trim();
}

function setProxyConfig(proxyUrl) {
  const s = readSettings();
  s.proxy = (proxyUrl || "").trim();
  writeSettings(s);
  cachedAgent = undefined;
  cachedProxyUrl = undefined;
}

function getProxyAgent() {
  const proxyUrl = getActiveProxyUrl();
  if (!proxyUrl) {
    return undefined; // direct connection
  }
  if (cachedAgent && cachedProxyUrl === proxyUrl) {
    return cachedAgent;
  }
  try {
    cachedProxyUrl = proxyUrl;
    cachedAgent = new HttpsProxyAgent(proxyUrl);
    return cachedAgent;
  } catch (err) {
    console.error(`Invalid proxy URL "${proxyUrl}":`, err.message);
    return undefined;
  }
}

function getCustomProxy() {
  const s = readSettings();
  return typeof s.proxy === "string" ? s.proxy : "";
}

function setCustomProxy(proxyUrl) {
  setProxyConfig(proxyUrl);
}

function getActiveProxyUrl() {
  const val = getProxyConfig();
  if (val.toLowerCase() === "direct" || !val) {
    return "";
  }
  return val;
}

module.exports = {
  getFastMode,
  setFastMode,
  getProxyConfig,
  setProxyConfig,
  getCustomProxy,
  setCustomProxy,
  getActiveProxyUrl,
  getProxyAgent,
  readSettings,
};

