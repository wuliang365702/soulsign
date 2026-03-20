const fs = require("fs");
const path = require("path");
const vm = require("vm");

const sourcePath = path.resolve(__dirname, "../js/offscreen.js");
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
    RECORDED_COMPLETION_TEXT: "录制完成",
    URL,
    Set,
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
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\nexpected: ${expected}\nactual: ${actual}`);
  }
}

function run() {
  const names = [
    "compareVersions",
    "deriveRecordedTaskName",
    "wrapRecordedScript",
    "markTaskRunStart",
    "markTaskRunSuccess",
    "markTaskRunFailure",
    "markTaskOnlineState",
    "parseTask",
    "normalizeResult",
    "isTaskDoneForCurrentWindow",
    "isTaskDueForCurrentWindow",
  ];
  const fns = loadFunctions(names);

  assertEqual(fns.compareVersions("1.2.0", "1.1.9"), 1, "compareVersions should detect newer version");
  assertEqual(fns.compareVersions("v1.0.0", "1.0.0"), 0, "compareVersions should ignore v prefix");
  assertEqual(fns.compareVersions("1.0.0", "1.0.1"), -1, "compareVersions should detect older version");
  assertEqual(
    fns.deriveRecordedTaskName("https://www.example.com/checkin"),
    "example.com",
    "deriveRecordedTaskName should strip www prefix"
  );
  assertEqual(
    fns.deriveRecordedTaskName("not-a-url"),
    "record-task",
    "deriveRecordedTaskName should fall back for invalid url"
  );

  const script = `// ==UserScript==
// @name              Demo Task
// @author            tester
// @domain            example.com
// @domain            *.example.org
// @grant             cookie,notify
// @param             username
// @param             password
// @freq              60000
// @expire            300000
// ==/UserScript==

exports.run = async function () {
  return "ok";
};`;

  const task = fns.parseTask(script);
  assertEqual(task.name, "Demo Task", "parseTask should read @name");
  assertEqual(task.author, "tester", "parseTask should read @author");
  assertEqual(task.domains.length, 2, "parseTask should collect multiple @domain entries");
  assertEqual(task.grants.join(","), "cookie,notify", "parseTask should split grants");
  assertEqual(task.params.join(","), "username,password", "parseTask should collect params");
  assertEqual(task.freq, 60000, "parseTask should parse numeric freq");
  assertEqual(task.expire, 300000, "parseTask should parse numeric expire");

  const normalizedOk = fns.normalizeResult(task, "签到成功");
  assertEqual(normalizedOk.summary, "签到成功", "normalizeResult should preserve text summary");
  assertEqual(normalizedOk.detail[0].errno, 0, "normalizeResult should mark success text as ok");

  const normalizedErr = fns.normalizeResult(task, "request failed");
  assertEqual(normalizedErr.detail[0].errno, 1, "normalizeResult should flag failure text");

  const helperNow = Date.UTC(2026, 2, 18, 8, 0, 0);
  const runTask = { cnt: 1, ok: 2, result: null, run_at: 0, success_at: 0, failure_at: 0, online_at: 0 };
  fns.markTaskRunStart(runTask, helperNow);
  assertEqual(runTask.run_at, helperNow, "markTaskRunStart should update run_at");
  assertEqual(runTask.cnt, 2, "markTaskRunStart should increment cnt");

  fns.markTaskRunSuccess(runTask, helperNow, "签到成功");
  assertEqual(runTask.success_at, helperNow, "markTaskRunSuccess should update success_at");
  assertEqual(runTask.ok, 3, "markTaskRunSuccess should increment ok");
  assertEqual(runTask.result.summary, "签到成功", "markTaskRunSuccess should normalize success result");

  fns.markTaskRunFailure(runTask, helperNow, "network error");
  assertEqual(runTask.failure_at, helperNow, "markTaskRunFailure should update failure_at");
  assertEqual(runTask.result.detail[0].errno, 1, "markTaskRunFailure should normalize failure result");

  fns.markTaskOnlineState(runTask, true, helperNow);
  assertEqual(runTask.online_at, helperNow, "markTaskOnlineState should store positive time for online");
  fns.markTaskOnlineState(runTask, false, helperNow);
  assertEqual(runTask.online_at, -helperNow, "markTaskOnlineState should store negative time for offline");

  const today = Date.UTC(2026, 2, 18, 0, 0, 0);
  const dayNow = today + 8 * 60 * 60 * 1000;

  assert(
    fns.isTaskDoneForCurrentWindow({ success_at: today + 1, freq: 0 }, dayNow, today),
    "daily task should be done after success today"
  );
  assert(
    !fns.isTaskDoneForCurrentWindow({ success_at: today - 1, freq: 0 }, dayNow, today),
    "daily task should not be done before today's window"
  );
  assert(
    fns.isTaskDoneForCurrentWindow({ success_at: dayNow - 30 * 1000, freq: 60 * 1000 }, dayNow, today),
    "interval task should be done inside freq window"
  );
  assert(
    fns.isTaskDueForCurrentWindow({ success_at: dayNow - 61 * 1000, freq: 60 * 1000 }, dayNow, today),
    "interval task should become due after freq window"
  );

  const recordedScript = fns.wrapRecordedScript("https://www.ibmnb.com/qd.php?from=test", "", ['await fb.click(".btna")']);
  assert(
    recordedScript.includes("// @name              ibmnb.com"),
    "wrapRecordedScript should derive task name from hostname"
  );
  assert(
    recordedScript.includes("// @loginURL          https://www.ibmnb.com/qd.php?from=test"),
    "wrapRecordedScript should keep the original login url"
  );
  assert(
    recordedScript.includes("// @param             name"),
    "wrapRecordedScript should include default account param"
  );
  assert(
    recordedScript.includes("// @param             pwd"),
    "wrapRecordedScript should include default password param"
  );
  assert(
    recordedScript.includes('await fb.waitLoaded(); // https://www.ibmnb.com/qd.php'),
    "wrapRecordedScript should append waitLoaded after a click action"
  );
  assert(
    recordedScript.includes('startsWith("https://www.ibmnb.com/qd.php")'),
    "wrapRecordedScript should validate the final url after a click action"
  );

  const emptyRecordedScript = fns.wrapRecordedScript("https://example.com/checkin", "", []);
  assert(
    emptyRecordedScript.includes('return "录制完成";'),
    "wrapRecordedScript should use the default completion text when no steps were recorded"
  );
  assert(
    !emptyRecordedScript.includes('return "签到成功";'),
    "wrapRecordedScript should avoid appending an unreachable success return for empty recordings"
  );

  console.log("verify-offscreen-pure: ok");
}

run();
