(function () {
  const STORAGE_KEYS = {
    tasks: "mv3_tasks",
    config: "mv3_config",
  };
  const MESSAGE_PATHS = {
    configGet: "config/get",
    configSet: "config/set",
    taskList: "task/list",
    taskRefresh: "task/refresh",
    taskAdd: "task/add",
    taskSet: "task/set",
    taskDelete: "task/del",
    taskRun: "task/run",
    taskDebug: "task/debug",
    taskCheck: "task/check",
    recordStart: "record/start",
    recordBegin: "record/begin",
    recordCode: "record/code",
    recordEnd: "record/end",
    internalTick: "__internal/tick",
  };
  const DEBUG_TIMEOUT_MS = 20000;
  const ONLINE_STATUS_RECHECK_MS = 900 * 1000;
  const RECORDED_COMPLETION_TEXT = "录制完成";
  const TASK_NOTIFICATION_TEXT = {
    failureAction: "点此查看或重试",
    offlineAction: "点此去登录或禁用它",
  };
  const DEFAULT_CONFIG = {
    version: 10000,
    notify_at: 0,
    upgrade_at: 0,
    notify_freq: 1800,
    retry_freq: 600,
    loop_freq: 3600,
    begin_at: 0,
    upgrade: false,
    upgrade_freq: 86400,
    timeout: 60,
    notify_url: "",
    local_notify: true,
    cross: true,
    allow_cross: {},
    cross_header: "Access-Control-Allow-Headers",
    last_refresh_at: 0,
    last_refresh_reason: "",
    last_refresh_done_at: 0,
    last_refresh_done_reason: "",
    last_refresh_stage: "",
    last_refresh_error: "",
  };
  function createSandboxFrame() {
    const iframe = document.createElement("iframe");
    iframe.id = "sandbox";
    iframe.src = chrome.runtime.getURL("sandbox.html");
    iframe.style.display = "none";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    document.body.appendChild(iframe);
    return iframe;
  }

  const iframe = createSandboxFrame();
  let sandboxReady = false;
  let sequence = 1;
  let nextHandle = 1;
  let tickInFlight = false;
  let lastTickAt = 0;
  const pending = new Map();
  const handles = new Map();
  const recordState = {
    url: "",
    title: "",
    prompted: false,
    startedAt: 0,
    lastAt: 0,
    codes: [],
  };

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function normalizeBeginAtHours(value) {
    const raw = Number(value || 0);
    if (!Number.isFinite(raw) || raw < 0) return 0;
    return Math.min(raw, 24);
  }

  function getDayStartTimestamp(now, beginAtHours) {
    const offsetMs = normalizeBeginAtHours(beginAtHours) * 3600000;
    return new Date(now - offsetMs).setHours(0, 0, 0, 0) + offsetMs;
  }

  function getTaskTimeout(config) {
    return Math.max(1000, Number(config.timeout || 60) * 1000);
  }

  function resetRecordState(url) {
    recordState.url = url || "";
    recordState.title = "";
    recordState.prompted = false;
    recordState.startedAt = 0;
    recordState.lastAt = 0;
    recordState.codes = [];
  }

  async function startRecordSession(url) {
    const tab = await bridge("tabs.create", { url, active: true });
    await bridge("cookies.set", { url, name: "__soulsign_record__", value: "1" });
    resetRecordState(url);
    self.__recordTab = tab.id;
    return true;
  }

  function beginRecordSession(body) {
    if (body && body.title) recordState.title = String(body.title);
    if (recordState.prompted) {
      return { showPrompt: false };
    }
    recordState.prompted = true;
    recordState.startedAt = Date.now();
    recordState.lastAt = recordState.startedAt;
    return { showPrompt: true };
  }

  async function finishRecordSession() {
    const code = wrapRecordedScript(recordState.url, recordState.title, recordState.codes);
    if (recordState.url) {
      try {
        await bridge("cookies.remove", { url: recordState.url, name: "__soulsign_record__" });
      } catch (error) {
        console.warn(error);
      }
    }
    resetRecordState();
    return code;
  }

  function withTimeout(promise, ms, message) {
    if (!ms || ms <= 0) return promise;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message || `timeout>${ms}ms`)), ms);
      Promise.resolve(promise).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  async function fetchTextWithTimeout(url, timeoutMs, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, Object.assign({}, init, { signal: controller.signal }));
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }

  function bridge(method, args) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ __bridge__: true, method, args }, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!resp) {
          reject(new Error(`bridge no response: ${method}`));
          return;
        }
        if (resp.no === 200) {
          resolve(resp.data);
          return;
        }
        reject(new Error(resp.msg || `bridge failed: ${method}`));
      });
    });
  }

  window.addEventListener("message", async (event) => {
    const data = event.data;
    if (!data || !data.__soulsign__) return;
    if (data.type === "sandbox-ready") {
      sandboxReady = true;
      return;
    }
    if (data.replyTo && pending.has(data.replyTo)) {
      const item = pending.get(data.replyTo);
      pending.delete(data.replyTo);
      data.ok ? item.resolve(data.payload) : item.reject(data.error);
      return;
    }
    if (data.type === "sandbox-call") {
      try {
        const payload = await sandboxCall(data.payload);
        event.source.postMessage(
          { __soulsign__: true, replyTo: data.id, ok: true, payload },
          "*"
        );
      } catch (error) {
        event.source.postMessage(
          { __soulsign__: true, replyTo: data.id, ok: false, error: String(error) },
          "*"
        );
      }
    }
  });

  async function waitSandbox() {
    for (let i = 0; i < 100; i++) {
      if (sandboxReady) return;
      await sleep(50);
    }
    throw new Error("sandbox not ready");
  }

  async function postToSandbox(type, payload) {
    await waitSandbox();
    return new Promise((resolve, reject) => {
      const id = "sandbox_" + sequence++;
      pending.set(id, { resolve, reject });
      iframe.contentWindow.postMessage({ __soulsign__: true, id, type, payload }, "*");
    });
  }

  async function getTasksMap() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEYS.tasks) || "{}");
    } catch (error) {
      console.warn(error);
      return {};
    }
  }

  async function setTasksMap(tasks) {
    localStorage.setItem(STORAGE_KEYS.tasks, JSON.stringify(tasks || {}));
  }

  async function getConfig() {
    try {
      const config = Object.assign(
        {},
        DEFAULT_CONFIG,
        JSON.parse(localStorage.getItem(STORAGE_KEYS.config) || "{}")
      );
      config.begin_at = normalizeBeginAtHours(config.begin_at);
      return config;
    } catch (error) {
      console.warn(error);
      return Object.assign({}, DEFAULT_CONFIG);
    }
  }

  async function setConfig(next) {
    const config = Object.assign(await getConfig(), next || {});
    config.begin_at = normalizeBeginAtHours(config.begin_at);
    localStorage.setItem(STORAGE_KEYS.config, JSON.stringify(config));
    return config;
  }

  function taskKey(task) {
    return `${task.author}/${task.name}`;
  }

  function compareVersions(left, right) {
    const a = String(left || "0").replace(/^v/i, "").split(".").map((item) => parseInt(item, 10) || 0);
    const b = String(right || "0").replace(/^v/i, "").split(".").map((item) => parseInt(item, 10) || 0);
    const size = Math.max(a.length, b.length);
    for (let i = 0; i < size; i++) {
      const av = a[i] || 0;
      const bv = b[i] || 0;
      if (av > bv) return 1;
      if (av < bv) return -1;
    }
    return 0;
  }

  function parseTask(text) {
    const beg = text.indexOf("==UserScript==");
    const end = text.indexOf("==/UserScript==");
    if (beg < 0 || end < 0 || beg > end) throw new Error("invalid userscript header");
    const task = { code: text };
    let meta = text.slice(beg + 14, end).replace(/\n\s*\/\/ ?/g, "\n");
    meta = meta
      .split(/\n\s*@/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of meta) {
      const match = /^\w+\s*/.exec(line);
      if (!match) continue;
      const key = match[0].trim();
      const value = line.slice(match[0].length).trim();
      if (task[key]) {
        const multi = task[key + "s"];
        if (multi) multi.push(value);
        else task[key + "s"] = [task[key], value];
      }
      task[key] = value;
    }
    if (!task.name) throw new Error("missing @name");
    if (!task.domain) throw new Error("missing @domain");
    task.author = task.author || "";
    task.domains = task.domains || [task.domain];
    task.grants = task.grants || (task.grant ? task.grant.split(",") : []);
    task.params = task.params || (task.param ? [task.param] : []);
    task._params = task._params || {};
    task.freq = +task.freq || 0;
    task.expire = +task.expire || 900000;
    task.enable = !!task.enable;
    task.online_at = +task.online_at || 0;
    task.run_at = +task.run_at || 0;
    task.success_at = +task.success_at || 0;
    task.failure_at = +task.failure_at || 0;
    task.ok = +task.ok || 0;
    task.cnt = +task.cnt || 0;
    delete task.domain;
    delete task.param;
    return task;
  }

  function normalizeResult(task, result) {
    const base = {
      summary: "",
      detail: [
        {
          domain: (task.domains && task.domains[0]) || "",
          url: "#",
          message: "NO_MESSAGE",
          errno: task.success_at < task.failure_at ? 1 : 0,
        },
      ],
    };
    if (result && typeof result === "object" && result.summary) return Object.assign(base, result);
    base.summary = String(result == null ? "" : result);
    base.detail[0].message = base.summary || "NO_MESSAGE";
    base.detail[0].errno = /error|failed|timeout|denied|refused/i.test(base.summary) ? 1 : 0;
    if (task.loginURL) {
      const match = String(task.loginURL).match(/([^:]+:\/\/[^\/]+)(.*)/);
      if (match) {
        // 与原版保持一致：成功时优先记录站点根地址，失败时保留完整登录地址。
        base.detail[0].url = base.detail[0].errno ? match[0] : match[1];
      }
    }
    return base;
  }

  function isTaskDoneForCurrentWindow(task, now, today) {
    const successAt = Number(task.success_at || 0);
    const freq = Number(task.freq || 0);
    if (!freq || freq >= 86400000) {
      return successAt >= today;
    }
    return successAt + freq >= now;
  }

  function isTaskDueForCurrentWindow(task, now, today) {
    return !isTaskDoneForCurrentWindow(task, now, today);
  }

  function checkDomain(domains, url) {
    try {
      const target = new URL(url).hostname.split(".");
      return domains.some((domain) => {
        if (domain === "*") return true;
        const parts = String(domain).split(".");
        if (parts.length !== target.length) return false;
        return parts.every((part, index) => part === "*" || part === target[index]);
      });
    } catch (error) {
      return false;
    }
  }

  async function ensureLoaded(tabId, timeout) {
    return bridge("tabs.waitComplete", { tabId, timeout });
  }

  async function evalInFrame(tabId, frameId, code) {
    const callId = "__soulsign_eval_" + Math.random().toString(36).slice(2);
    const results = await bridge("scripting.execute", {
      target: { tabId, frameIds: [frameId] },
      world: "MAIN",
      args: [code, callId],
    });
    const first = Array.isArray(results) ? results[0] : null;
    const result = first && first.result;
    if (!result || !result.ok) throw new Error((result && result.error) || "executeScript failed");
    return result.value;
  }

  async function createHandle(tabId, frameId, domains, url, windowId) {
    const handle = String(nextHandle++);
    handles.set(handle, { tabId, frameId, domains, url, windowId });
    return handle;
  }

  function deriveRecordedTaskName(url) {
    try {
      return new URL(url).hostname.replace(/^www\./i, "") || "record-task";
    } catch (error) {
      return "record-task";
    }
  }

  function wrapRecordedScript(url, title, codes) {
    if (!url) return codes.join("\n");
    const domains = new Set();
    const match = /^https?:\/\/([^/]+)/i.exec(url);
    if (match) domains.add(match[1]);
    const taskName = deriveRecordedTaskName(url);
    codes.join("\n").replace(/https?:\/\/([^/"'\s)]+)/g, (_, domain) => {
      domains.add(domain);
      return _;
    });
    const targetUrl = JSON.stringify(url.split("?")[0]);
    const recordedLines = codes.length ? codes.slice() : [];
    if (recordedLines.length) {
      const lastLine = recordedLines[recordedLines.length - 1] || "";
      if (/fb\.click\(/.test(lastLine) || /fb\.press\(/.test(lastLine)) {
        recordedLines.push(`await fb.waitLoaded(); // ${url.split("?")[0]}`);
        recordedLines.push(
          `if(!(await fb.eval("location.href")).startsWith(${targetUrl})) throw "签到失败"`
        );
      }
    }
    const body = recordedLines.map((line) => `    ${line}`).join("\n");
    const finalReturn = recordedLines.length
      ? '    return "签到成功";'
      : `    return ${JSON.stringify(RECORDED_COMPLETION_TEXT)};`;
    return `// ==UserScript==
// @name              ${taskName}
// @version           1.0.0
// @author            魂签录制
// @loginURL          ${url}
// @expire            300e3
${Array.from(domains)
  .map((domain) => `// @domain            ${domain}`)
  .join("\n")}
// @param             name 账号
// @param             pwd 密码
// ==/UserScript==

exports.run = async function(param) {
  // 使用浏览器打开签到页面，并获取窗口句柄
  return await open(${JSON.stringify(url)}, false, async function(fb) {
    var rate = 0.5; // 间隔时间倍率，值越小脚本执行越快
${body ? `${body}\n` : ""}${finalReturn}
  });
};

exports.check = async function(param) {
  return true;
};
`;
  }

  async function sandboxCall(payload) {
    const { method, args } = payload;
    if (method === "fetch") {
      const [request] = args;
      const response = await fetch(request.url, {
        method: request.method || "GET",
        headers: request.headers || {},
        body: request.body,
        credentials: request.credentials || "include",
        redirect: "follow",
      });
      return {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        data: await response.text(),
      };
    }
    if (method === "getCookie") {
      const [url, name] = args;
      const cookie = await bridge("cookies.get", { url, name });
      return cookie && cookie.value;
    }
    if (method === "setCookie") {
      const [url, name, value] = args;
      const cookie = await bridge("cookies.set", { url, name, value });
      return cookie && cookie.value;
    }
    if (method === "notify") {
      const [title, body, url] = args;
      const id = "notify_" + Math.random().toString(36).slice(2);
      await bridge("notifications.create", {
        id,
        options: {
          type: "basic",
          iconUrl: "icons/48.png",
          title,
          message: body || "",
        },
      });
      await bridge("notifications.waitClick", { id, url });
      return true;
    }
    if (method === "open") {
      const [options] = args;
      if (!checkDomain(options.domains || [], options.url)) {
        throw new Error("invalid domain config");
      }
      let windowId;
      if (options.windowMode) {
        const win = await bridge(
          "windows.create",
          options.active
            ? {
                left: 0,
                top: 0,
                width: 1440,
                height: 900,
                focused: true,
                type: "normal",
              }
            : { state: "minimized", focused: false, type: "normal" }
        );
        windowId = win.id;
      }
      if (options.preload) {
        await bridge("cookies.set", {
          url: options.url,
          name: "__soulsign_inject__",
          value: encodeURIComponent(options.preload),
        });
      }
      const createOptions = {
        url: options.url,
        active: !!options.active,
      };
      if (windowId != null) createOptions.windowId = windowId;
      const tab = await bridge("tabs.create", createOptions);
      await ensureLoaded(tab.id, options.timeout || 10000);
      const resolved = await bridge("tabs.get", tab.id);
      const finalUrl = resolved.url || resolved.pendingUrl || options.url;
      const handle = await createHandle(tab.id, 0, options.domains || [], finalUrl, windowId);
      return { handle, url: finalUrl };
    }
    if (method === "closeHandle") {
      const [handle] = args;
      const info = handles.get(handle);
      if (!info) return false;
      try {
        await bridge("tabs.remove", info.tabId);
      } catch (error) {
        console.warn(error);
      }
      if (info.windowId) {
        try {
          await bridge("windows.remove", info.windowId);
        } catch (error) {
          console.warn(error);
        }
      }
      handles.delete(handle);
      return true;
    }
    if (method === "frame.eval") {
      const [handle, code] = args;
      const info = handles.get(handle);
      if (!info) throw new Error("frame not found");
      return evalInFrame(info.tabId, info.frameId, code);
    }
    if (method === "frame.waitLoaded") {
      const [handle, timeout] = args;
      const info = handles.get(handle);
      if (!info) throw new Error("frame not found");
      return ensureLoaded(info.tabId, timeout || 10000);
    }
    if (method === "frame.iframes") {
      const [handle] = args;
      const info = handles.get(handle);
      if (!info) throw new Error("frame not found");
      const frames = await bridge("webNavigation.getAllFrames", { tabId: info.tabId });
      const result = [];
      for (const frame of frames.filter((item) => checkDomain(info.domains || [], item.url || ""))) {
        const frameHandle = await createHandle(
          info.tabId,
          frame.frameId,
          info.domains,
          frame.url,
          info.windowId
        );
        result.push({ handle: frameHandle, url: frame.url });
      }
      return result;
    }
    if (method === "frame.getFrame") {
      const [handle, targetUrl, fuzzy] = args;
      const info = handles.get(handle);
      if (!info) throw new Error("frame not found");
      let tries = 10;
      while (tries-- > 0) {
        const frames = await bridge("webNavigation.getAllFrames", { tabId: info.tabId });
        const hit = frames.find((frame) => {
          if (!checkDomain(info.domains || [], frame.url || "")) return false;
          if (fuzzy > 1) return frame.url.startsWith(targetUrl.split("?")[0]);
          return frame.url === targetUrl || frame.url.startsWith(targetUrl);
        });
        if (hit) {
          const frameHandle = await createHandle(
            info.tabId,
            hit.frameId,
            info.domains,
            hit.url,
            info.windowId
          );
          return { handle: frameHandle, url: hit.url };
        }
        await sleep(1000);
      }
      throw new Error("iframe lookup timeout");
    }
    throw new Error("unsupported sandbox call: " + method);
  }

  async function listTasks() {
    return Object.values(await getTasksMap());
  }

  async function addTask(scriptText) {
    const task = parseTask(scriptText);
    await postToSandbox("compile", { task });
    const tasks = await getTasksMap();
    tasks[taskKey(task)] = task;
    await setTasksMap(tasks);
    return task;
  }

  async function debugTask(body) {
    const task = parseTask(body.code || "");
    task._params = body.params || {};
    task._timeout = Number(body.timeout || 0) || DEBUG_TIMEOUT_MS;
    const startedAt = Date.now();
    let value;
    if (body.mode === "check") {
      value = await withTimeout(postToSandbox("check", { task }), task._timeout, `task check timeout>${task._timeout}ms`);
    } else if (body.mode === "run") {
      value = await withTimeout(postToSandbox("run", { task }), task._timeout, `task run timeout>${task._timeout}ms`);
    } else {
      throw new Error("unsupported debug mode");
    }
    return {
      ok: true,
      mode: body.mode,
      key: taskKey(task),
      started_at: startedAt,
      ended_at: Date.now(),
      duration_ms: Date.now() - startedAt,
      timeout_ms: task._timeout,
      params: task._params,
      value,
    };
  }

  async function sendNotify(config, title, body, url) {
    if (config.notify_url) {
      try {
        const target = String(config.notify_url)
          .replace(/\$MSG/g, encodeURIComponent(title + (body ? `@${body}` : "")))
          .replace(/\$URL/g, encodeURIComponent(url || ""));
        await fetch(target, { method: "GET", credentials: "omit" });
      } catch (error) {
        console.warn("notify_url failed", error);
      }
    }
    if (config.local_notify) {
      const id = "notify_" + Math.random().toString(36).slice(2);
      await bridge("notifications.create", {
        id,
        url,
        options: {
          type: "basic",
          iconUrl: chrome.runtime.getURL("icons/48.png"),
          title,
          message: body || "",
        },
      });
    }
  }

  async function notifyWithThrottle(config, title, body, url, now) {
    if ((config.notify_at || 0) + config.notify_freq * 1000 > now) return config;
    await sendNotify(config, title, body, url);
    config.notify_at = now;
    await setConfig({ notify_at: now });
    return config;
  }

  function hasTaskIssue(task) {
    if (!task || !task.enable) return false;
    if (Number(task.online_at || 0) < 0) return true;
    if (Number(task.failure_at || 0) > Number(task.success_at || 0)) return true;
    const detail = task.result && Array.isArray(task.result.detail) ? task.result.detail : [];
    return detail.some((item) => Number(item && item.errno) > 0);
  }

  function getErrorCount(tasks) {
    return Object.values(tasks || {}).filter((task) => hasTaskIssue(task)).length;
  }

  function getTaskNotifyTitle(task, kind) {
    if (kind === "failure") return `${task.name} 签到失败`;
    if (kind === "offline") return `${task.name} 不在线`;
    return String(task && task.name ? task.name : "");
  }

  function getUpgradeNotifyTitle(updated) {
    if (!Array.isArray(updated) || !updated.length) return "";
    return `${updated[0].name}${updated.length > 1 ? ` 等 ${updated.length - 1} 个脚本` : ""} 已更新`;
  }

  function markTaskRunStart(task, now) {
    task.run_at = now;
    task.cnt = (task.cnt || 0) + 1;
    return task;
  }

  function markTaskRunSuccess(task, now, result) {
    task.success_at = now;
    task.ok = (task.ok || 0) + 1;
    task.result = normalizeResult(task, result);
    return task;
  }

  function markTaskRunFailure(task, now, error) {
    task.failure_at = now;
    task.result = normalizeResult(task, String(error));
    return task;
  }

  function markTaskOnlineState(task, online, now) {
    task.online_at = online ? now : -now;
    return task;
  }

  // 在线状态复查优先使用脚本自己的 @expire，未提供时再回退到全局兜底值。
  function getOnlineRecheckMs(task) {
    const expire = Number(task && task.expire);
    return expire > 0 ? expire : ONLINE_STATUS_RECHECK_MS;
  }

  async function checkTaskOnline(config, task, now) {
    task._timeout = getTaskTimeout(config);
    try {
      const online = await withTimeout(
        postToSandbox("check", { task }),
        task._timeout,
        `task check timeout>${task._timeout}ms`
      );
      markTaskOnlineState(task, online, now);
      return { online: !!online, error: null };
    } catch (error) {
      markTaskOnlineState(task, false, now);
      return { online: false, error };
    }
  }

  async function updateBadge(tasks) {
    const errorCount = getErrorCount(tasks);
    await bridge("action.setBadge", {
      text: errorCount ? String(errorCount) : "",
      color: "#F44336",
    });
    return errorCount;
  }

  async function notifyTaskWithThrottle(config, task, kind, title, body, url, now) {
    const key = `${kind}_notify_at`;
    if ((task[key] || 0) + config.notify_freq * 1000 > now) return false;
    await sendNotify(config, title, body, url);
    task[key] = now;
    return true;
  }

  async function notifyTaskFailure(config, task, now) {
    return notifyTaskWithThrottle(
      config,
      task,
      "failure",
      getTaskNotifyTitle(task, "failure"),
      TASK_NOTIFICATION_TEXT.failureAction,
      task.loginURL || "",
      now
    );
  }

  async function notifyTaskOffline(config, task, now) {
    return notifyTaskWithThrottle(
      config,
      task,
      "offline",
      getTaskNotifyTitle(task, "offline"),
      TASK_NOTIFICATION_TEXT.offlineAction,
      task.loginURL || "",
      now
    );
  }

  function mergeRuntimeState(prev, next) {
    return Object.assign({}, prev, next, {
      code: next.code,
      version: next.version,
      domains: next.domains,
      grants: next.grants,
      params: next.params,
      expire: next.expire,
      loginURL: next.loginURL,
      updateURL: next.updateURL,
      _params: prev._params || {},
      enable: prev.enable,
      online_at: prev.online_at,
      run_at: prev.run_at,
      success_at: prev.success_at,
      failure_at: prev.failure_at,
      ok: prev.ok,
      cnt: prev.cnt,
      result: prev.result,
    });
  }

  async function upgradeTasksIfNeeded(config, tasks, now) {
    if (!config.upgrade) return { tasks, updated: [] };
    if ((config.upgrade_at || 0) + config.upgrade_freq * 1000 > now) return { tasks, updated: [] };
    const updated = [];
    const updateTimeout = Math.max(5000, Number(config.timeout || 60) * 1000);
    for (const key of Object.keys(tasks)) {
      const task = tasks[key];
      if (!task.updateURL) continue;
      try {
        const text = await fetchTextWithTimeout(task.updateURL, updateTimeout, {
          credentials: "include",
        });
        const nextTask = parseTask(text);
        if (nextTask.author !== task.author || nextTask.name !== task.name) continue;
        if (compareVersions(nextTask.version, task.version) > 0) {
          tasks[key] = mergeRuntimeState(task, nextTask);
          updated.push(tasks[key]);
        }
      } catch (error) {
        console.warn("upgrade failed", task.name, error);
      }
    }
    config.upgrade_at = now;
    await setConfig({ upgrade_at: now });
    return { tasks, updated };
  }

  async function runTaskByKey(key) {
    const config = await getConfig();
    const tasks = await getTasksMap();
    const task = tasks[key];
    if (!task) throw new Error("task not found");
    const now = Date.now();
    markTaskRunStart(task, now);
    task._timeout = getTaskTimeout(config);
    try {
      const result = await withTimeout(
        postToSandbox("run", { task }),
        task._timeout,
        `task run timeout>${task._timeout}ms`
      );
      markTaskRunSuccess(task, now, result);
    } catch (error) {
      markTaskRunFailure(task, now, error);
      await notifyTaskFailure(config, task, now);
    }
    tasks[key] = task;
    await setTasksMap(tasks);
    await updateBadge(tasks);
    return task;
  }

  async function checkTaskByKey(key) {
    const config = await getConfig();
    const tasks = await getTasksMap();
    const task = tasks[key];
    if (!task) throw new Error("task not found");
    const now = Date.now();
    const checked = await checkTaskOnline(config, task, now);
    if (!checked.online) {
      await notifyTaskOffline(config, task, now);
    }
    tasks[key] = task;
    await setTasksMap(tasks);
    await updateBadge(tasks);
    return task;
  }

  async function schedulerTick(trigger) {
    if (tickInFlight) return true;
    tickInFlight = true;
    const config = await getConfig();
    const triggerReason = trigger && trigger.reason ? String(trigger.reason) : "manual";
    const triggerAt = Date.now();
    await setConfig({
      last_refresh_at: triggerAt,
      last_refresh_reason: triggerReason,
      last_refresh_stage: "started",
      last_refresh_error: "",
    });
    try {
      const initialTasks = await getTasksMap();
      const now = triggerAt;
      const today = getDayStartTimestamp(now, config.begin_at);
      await setConfig({ last_refresh_stage: "upgrade" });
      const { tasks, updated } = await upgradeTasksIfNeeded(config, initialTasks, now);
      for (const key of Object.keys(tasks)) {
        const task = tasks[key];
        if (!task.enable) continue;
        const done = isTaskDoneForCurrentWindow(task, now, today);
        if (done) {
          tasks[key] = task;
          continue;
        }
        const shouldCheck =
          !task.online_at || Math.abs(task.online_at) + getOnlineRecheckMs(task) < now;
        if (shouldCheck) {
          await setConfig({ last_refresh_stage: `check:${key}` });
          const checked = await checkTaskOnline(config, task, now);
          if (!checked.online) {
            await notifyTaskOffline(config, task, now);
            tasks[key] = task;
            continue;
          }
        }
        const due = isTaskDueForCurrentWindow(task, now, today);
        const retryable = task.failure_at + config.retry_freq * 1000 <= now;
        if (due && retryable) {
          await setConfig({ last_refresh_stage: `run:${key}` });
          markTaskRunStart(task, now);
          task._timeout = getTaskTimeout(config);
          try {
            const result = await withTimeout(
              postToSandbox("run", { task }),
              task._timeout,
              `task run timeout>${task._timeout}ms`
            );
            markTaskRunSuccess(task, now, result);
          } catch (error) {
            markTaskRunFailure(task, now, error);
          }
        }
        if ((task.failure_at || 0) > (task.success_at || 0)) {
          await notifyTaskFailure(config, task, now);
        }
        tasks[key] = task;
      }
      if (updated.length) {
        await sendNotify(
          config,
          getUpgradeNotifyTitle(updated),
          "",
          chrome.runtime.getURL("options.html")
        );
      }
      await setTasksMap(tasks);
      await updateBadge(tasks);
      lastTickAt = now;
      await setConfig({
        last_refresh_done_at: now,
        last_refresh_done_reason: triggerReason,
        last_refresh_stage: "done",
        last_refresh_error: "",
      });
      return true;
    } catch (error) {
      await setConfig({
        last_refresh_stage: "error",
        last_refresh_error: String(error),
      });
      throw error;
    } finally {
      tickInFlight = false;
    }
  }

  const api = {
    async [MESSAGE_PATHS.configGet]() {
      return getConfig();
    },
    async [MESSAGE_PATHS.configSet](body) {
      return setConfig(body);
    },
    async [MESSAGE_PATHS.taskList]() {
      return listTasks();
    },
    async [MESSAGE_PATHS.taskRefresh](body) {
      return schedulerTick(body);
    },
    async [MESSAGE_PATHS.taskAdd](body) {
      const task = await addTask(body.code || body);
      await updateBadge(await getTasksMap());
      return task;
    },
    async [MESSAGE_PATHS.taskSet](body) {
      const tasks = await getTasksMap();
      tasks[taskKey(body)] = Object.assign(tasks[taskKey(body)] || {}, body);
      await setTasksMap(tasks);
      await updateBadge(tasks);
      return tasks[taskKey(body)];
    },
    async [MESSAGE_PATHS.taskDelete](body) {
      const tasks = await getTasksMap();
      delete tasks[body];
      await setTasksMap(tasks);
      await updateBadge(tasks);
      return true;
    },
    async [MESSAGE_PATHS.taskRun](body) {
      return runTaskByKey(body);
    },
    async [MESSAGE_PATHS.taskDebug](body) {
      return debugTask(body);
    },
    async [MESSAGE_PATHS.taskCheck](body) {
      return checkTaskByKey(body);
    },
    async [MESSAGE_PATHS.recordStart](body) {
      return startRecordSession(body.url);
    },
    async [MESSAGE_PATHS.recordBegin](body) {
      return beginRecordSession(body);
    },
    async [MESSAGE_PATHS.recordCode](body) {
      if (!body) return true;
      const now = Date.now();
      if (recordState.lastAt) {
        recordState.codes.push(`await fb.sleep(${now - recordState.lastAt} * rate)`);
      }
      recordState.codes.push(body);
      recordState.lastAt = now;
      return true;
    },
    async [MESSAGE_PATHS.recordEnd]() {
      return finishRecordSession();
    },
    async [MESSAGE_PATHS.internalTick]() {
      if (Date.now() - lastTickAt < 1000) return true;
      return schedulerTick({ reason: MESSAGE_PATHS.internalTick });
    },
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.__to_offscreen__) return false;
    const handler = api[message.path];
    if (!handler) return false;
    (async () => {
      try {
        const data = await handler(message.body);
        sendResponse({ no: 200, data, __from_offscreen__: true });
      } catch (error) {
        console.error(error);
        sendResponse({ no: 500, msg: String(error), __from_offscreen__: true });
      }
    })();
    return true;
  });
})();
