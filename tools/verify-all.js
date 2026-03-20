const path = require("path");
const { spawnSync } = require("child_process");

const scripts = [
  "verify-offscreen-pure.js",
  "verify-options-pure.js",
];

for (const script of scripts) {
  const fullPath = path.resolve(__dirname, script);
  const result = spawnSync(process.execPath, [fullPath], { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

console.log("verify-all: ok");
