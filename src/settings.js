const fs = require("fs");
const path = require("path");

const SETTINGS_FILE = path.join(__dirname, "..", "data", "settings.json");

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

module.exports = { getFastMode, setFastMode };
