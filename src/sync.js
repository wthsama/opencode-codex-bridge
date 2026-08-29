const fs = require("fs");
const path = require("path");
const os = require("os");
const { fetchModels } = require("./models");
const { getValidAccessToken } = require("./auth");

const OPENCODE_CONFIG = path.join(os.homedir(), ".config", "opencode", "opencode.json");
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
  try {
    return JSON.parse(fs.readFileSync(OPENCODE_CONFIG, "utf8"));
  } catch {
    return null;
  }
}

function writeOpenCodeConfig(config) {
  const backupPath = OPENCODE_CONFIG + ".backup";
  if (fs.existsSync(OPENCODE_CONFIG)) {
    fs.copyFileSync(OPENCODE_CONFIG, backupPath);
  }
  fs.writeFileSync(OPENCODE_CONFIG, JSON.stringify(config, null, 2) + "\n", "utf8");
}

async function syncModels() {
  const auth = await getValidAccessToken();
  if (!auth) return { status: "unauthenticated" };

  const remoteModels = await fetchModels(auth.access_token, auth.account_id);
  const newModels = buildCodexLocalModels(remoteModels.data);

  let config = readOpenCodeConfig();
  if (!config) return { status: "no_config", path: OPENCODE_CONFIG };

  if (!config.provider) config.provider = {};
  config.provider["codex-local"] = {
    npm: "@ai-sdk/openai",
    options: {
      apiKey: "PROXY_MANAGED",
      baseURL: "http://127.0.0.1:15722/v1",
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
