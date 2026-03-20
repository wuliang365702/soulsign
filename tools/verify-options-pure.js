const fs = require("fs");
const path = require("path");
const vm = require("vm");

const sourcePath = path.resolve(__dirname, "../js/options.js");
const source = fs.readFileSync(sourcePath, "utf8");

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start < 0) {
    throw new Error(`Function not found: ${name}`);
  }

  let braceIndex = source.indexOf("{", start);
  if (braceIndex < 0) {
    throw new Error(`Function body not found: ${name}`);
  }

  let depth = 0;
  let end = braceIndex;
  for (; end < source.length; end++) {
    const ch = source[end];
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        end++;
        break;
      }
    }
  }

  return source.slice(start, end);
}

function loadFunctions(names) {
  const context = {
    URL,
    Date,
    Math,
    Number,
    String,
    JSON,
  };
  vm.createContext(context);
  for (const name of names) {
    const fnSource = extractFunction(name);
    vm.runInContext(`${fnSource}; this.${name} = ${name};`, context, { filename: sourcePath });
  }
  return context;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\nexpected: ${expected}\nactual: ${actual}`);
  }
}

function run() {
  const names = [
    "pad",
    "formatTime",
    "taskKey",
    "normalizeCrossDomain",
    "decodeCrossRule",
    "encodeCrossRule",
    "extractParamsFromCode",
    "extractTaskIdentityFromCode",
  ];
  const fns = loadFunctions(names);

  assertEqual(fns.pad(3), "03", "pad should left-pad single digits");
  const sample = new Date(2026, 2, 18, 9, 5, 0, 0);
  assertEqual(
    fns.formatTime(sample.getTime()),
    "2026-03-18 09:05",
    "formatTime should format timestamp in local time"
  );
  assertEqual(fns.taskKey({ author: "tester", name: "demo" }), "tester/demo", "taskKey should compose key");

  assertEqual(
    fns.normalizeCrossDomain("example.com"),
    "https://example.com",
    "normalizeCrossDomain should default to https"
  );
  assertEqual(
    fns.normalizeCrossDomain("http://example.com:8080/path?a=1"),
    "http://example.com:8080",
    "normalizeCrossDomain should normalize protocol and host"
  );

  let invalidThrown = false;
  try {
    fns.normalizeCrossDomain("ftp://example.com");
  } catch (error) {
    invalidThrown = String(error).includes("仅支持 http 或 https 站点");
  }
  assert(invalidThrown, "normalizeCrossDomain should reject unsupported protocols");

  const decoded = fns.decodeCrossRule(3);
  assertEqual(decoded.enabled, true, "decodeCrossRule should decode enabled flag");
  assertEqual(decoded.cookie, true, "decodeCrossRule should decode cookie flag");
  assertEqual(fns.encodeCrossRule({ enabled: true, cookie: false }), 1, "encodeCrossRule should encode flags");

  const code = `// @param username\n// @param password\n// @name Demo\n// @author tester`;
  assertEqual(
    fns.extractParamsFromCode(code).join(","),
    "username,password",
    "extractParamsFromCode should parse all @param lines"
  );
  assertEqual(
    fns.extractTaskIdentityFromCode(code),
    "tester/Demo",
    "extractTaskIdentityFromCode should build author/name identity"
  );

  console.log("verify-options-pure: ok");
}

run();
