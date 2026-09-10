const fs = require("fs");
const path = require("path");
const os = require("os");
const { fetchModels } = require("./models");
const { getValidAccessToken } = require("./auth");

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "opencode", "opencode.json");

function getOpenCodeConfigPath() {
  return process.env.OPENCODE_CONFIG_PATH || DEFAULT_CONFIG_PATH;
}

function getBaseURL() {
  return process.env.OPENCODE_BASE_URL || `http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || "15722"}/v1`;
}
const REASONING_VARIANTS = {
  low: { reasoningEffort: "low" },
  medium: { reasoningEffort: "medium" },
  high: { reasoningEffort: "high" },
  xhigh: { reasoningEffort: "xhigh" },
};

function buildCodexLocalModels(modelList) {
  const models = {};
  for (const m of modelList) {
    models[m.id] = {
      name: m.id,
      attachment: true,
      modalities: {
        input: ["text", "image"],
        output: ["text"],
      },
      variants: { ...REASONING_VARIANTS },
    };
  }
  return models;
}

function readOpenCodeConfig() {
  const configPath = getOpenCodeConfigPath();
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

function writeOpenCodeConfig(config) {
  const configPath = getOpenCodeConfigPath();
  const backupPath = configPath + ".backup";
  if (fs.existsSync(configPath)) {
    fs.copyFileSync(configPath, backupPath);
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

async function syncModels() {
  const auth = await getValidAccessToken();
  if (!auth) return { status: "unauthenticated" };

  const remoteModels = await fetchModels(auth.access_token, auth.account_id);
  const newModels = buildCodexLocalModels(remoteModels.data);

  let config = readOpenCodeConfig();
  if (!config) return { status: "no_config", path: getOpenCodeConfigPath() };

  if (!config.provider) config.provider = {};
  config.provider["codex-local"] = {
    npm: "@ai-sdk/openai",
    options: {
      apiKey: "PROXY_MANAGED",
      baseURL: getBaseURL(),
    },
    models: newModels,
  };

  writeOpenCodeConfig(config);
  return {
    status: "ready",
    modelCount: Object.keys(newModels).length,
    models: Object.keys(newModels),
  };
}

module.exports = { syncModels };
