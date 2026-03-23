(function () {
  // 与 MV3 后台 / offscreen 通信时使用的消息路径。
  const MESSAGE_PATHS = {
    configGet: "config/get",
    configSet: "config/set",
    taskList: "task/list",
    taskAdd: "task/add",
    taskSet: "task/set",
    taskDelete: "task/del",
    taskRun: "task/run",
    taskDebug: "task/debug",
    taskCheck: "task/check",
    recordStart: "record/start",
    recordEnd: "record/end",
  };
  const DEBUG_TIMEOUT_MS = 20000;
  const ONLINE_STATUS_RECHECK_MS = 900 * 1000;
  const NO_DETAIL_ROWS_TEXT = "没有可展示的执行明细";
  const defaultCode = `// ==UserScript==
// @name              SCRIPT_NAME
// @version           1.0.0
// @author            SCRIPT_AUTHOR
// @loginURL          https://www.example.com/login
// @expire            300e3
// @domain            example.com
// ==/UserScript==

exports.run = async function(param) {
  return "签到成功";
};

exports.check = async function(param) {
  return true;
};
`;

  function createDetailDialogState() {
    return {
      task: null,
      details: [],
      expandedRows: [],
      mode: "",
    };
  }

  const state = {
    tasks: [],
    taskRowMap: new Map(),
    paramsTaskKey: "",
    editorTaskKey: "",
    checkingOnline: false,
    recording: false,
    finishingRecord: false,
    editorDebugParams: {},
    refreshTimer: 0,
    refreshPromise: null,
    refreshQueued: false,
    lastRefreshAt: 0,
    crossConfig: {
      cross_header: "",
      allow_cross: {},
      cross: false,
    },
    detailDialog: createDetailDialogState(),
  };

  const taskBody = document.getElementById("task-body");
  const emptyState = document.getElementById("empty-state");
  const fileInput = document.getElementById("file-input");
  const scriptEl = document.getElementById("script");
  const scriptHighlightEl = document.getElementById("script-highlight");
  const editorOverlay = document.getElementById("editor-overlay");
  const configOverlay = document.getElementById("config-overlay");
  const detailOverlay = document.getElementById("detail-overlay");
  const paramsOverlay = document.getElementById("params-overlay");
  const recordOverlay = document.getElementById("record-overlay");
  const editorTitle = document.getElementById("editor-title");
  const detailTitle = document.getElementById("detail-title");
  const detailSummary = document.getElementById("detail-summary");
  const detailHeadRow = document.getElementById("detail-head-row");
  const detailBody = document.getElementById("detail-body");
  const detailTable = detailOverlay.querySelector(".detail-table");
  const paramsTitle = document.getElementById("params-title");
  const paramsFields = document.getElementById("params-fields");
  const toastEl = document.getElementById("toast");
  const versionEl = document.getElementById("app-version");
  const recordUrlEl = document.getElementById("record-url");
  const crossHeaderEl = configOverlay.querySelector("#cross_header");
  const crossDomainEl = configOverlay.querySelector("#cross_domain");
  const crossBodyEl = configOverlay.querySelector("#cross-body");
  const crossEmptyEl = configOverlay.querySelector("#cross-empty");
  const closeConfigEl = document.getElementById("close-config");
  const cancelConfigEl = document.getElementById("cancel-config");
  const saveConfigEl = document.getElementById("save-config");
  const addCrossEl = configOverlay.querySelector("#add-cross");

  // 整个管理页都会用到的基础 UI 工具函数。
  function send(path, body) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ path, body }, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!resp) {
          reject(new Error("no response"));
          return;
        }
        if (resp.no === 200) {
          resolve(resp.data);
          return;
        }
        reject(new Error(resp.msg || "request failed"));
      });
    });
  }

  function showToast(message) {
    toastEl.textContent = String(message || "");
    toastEl.classList.add("show");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
      toastEl.classList.remove("show");
    }, 2400);
  }

  function reportError(error) {
    alert(String(error));
  }

  function bindAsyncClick(id, handler) {
    document.getElementById(id).addEventListener("click", () => {
      Promise.resolve(handler()).catch(reportError);
    });
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function formatAgo(value) {
    if (!value) return "未执行";
    const diff = Math.max(0, Date.now() - Math.abs(value));
    const second = 1000;
    const minute = 60 * second;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diff < second) return "刚刚";
    if (diff < minute) return `${Math.floor(diff / second)}秒前`;
    if (diff < hour) return `${Math.floor(diff / minute)}分钟前`;
    if (diff < day) return `${Math.floor(diff / hour)}小时前`;
    return `${Math.floor(diff / day)}天前`;
  }

  function formatTime(value) {
    if (!value) return "未执行";
    const date = new Date(Math.abs(value));
    if (Number.isNaN(date.getTime())) return "未执行";
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
      date.getHours()
    )}:${pad(date.getMinutes())}`;
  }

  function formatTimeSeconds(value) {
    if (!value) return "\u672a\u6267\u884c";
    const date = new Date(Math.abs(value));
    if (Number.isNaN(date.getTime())) return "\u672a\u6267\u884c";
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function exportFileName() {
    const now = new Date();
    return `Soulsign${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(
      now.getHours()
    )}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`;
  }

  function onlineStatus(task) {
    if (task.online_at < 0) return { text: "不在线", className: "status-offline", title: formatTime(task.online_at) };
    if (task.online_at > 0) return { text: formatAgo(task.online_at), className: "status-online", title: formatTime(task.online_at) };
    return { text: "未检查", className: "", title: "" };
  }

  function domainBadge(domain) {
    const text = String(domain || "*")
      .replace(/^www\./i, "")
      .split(".")
      .slice(0, 2)
      .map((part) => part[0] || "")
      .join("")
      .slice(0, 2)
      .toUpperCase();
    return `<span class="domain-badge" title="${escapeHtml(domain || "*")}">${text || "*"}</span>`;
  }

  function faviconUrl(task, domain) {
    let source = "";
    if (task && task.loginURL) source = String(task.loginURL);
    else if (domain && domain !== "*") source = /^https?:\/\//i.test(domain) ? String(domain) : `https://${domain}`;
    if (!source) return "";
    const url = new URL(chrome.runtime.getURL("/_favicon/"));
    url.searchParams.set("pageUrl", source);
    url.searchParams.set("size", "16");
    return url.toString();
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

  function getOnlineRecheckMs(task) {
    const expire = Number(task && task.expire);
    return expire > 0 ? expire : ONLINE_STATUS_RECHECK_MS;
  }

  // 任务列表渲染相关的辅助函数。
  function renderSiteCell(task) {
    const domains = task.domains || [];
    return domains
      .map((domain) => {
        const iconUrl = faviconUrl(task, domain);
        if (!iconUrl) return domainBadge(domain);
        return `
          <span class="domain-badge" title="${escapeHtml(domain)}">
            <img
              class="site-icon"
              src="${escapeHtml(iconUrl)}"
              alt="${escapeHtml(domain)}"
              loading="lazy"
            >
          </span>
        `;
      })
      .join("");
  }

  function taskKey(task) {
    return `${task.author}/${task.name}`;
  }

  function taskLink(task) {
    if (task.loginURL) return task.loginURL;
    const domain = (task.domains || [])[0];
    if (!domain) return "";
    if (/^https?:\/\//i.test(domain)) return domain;
    return `https://${domain}`;
  }

  function hasTaskError(task) {
    const detail = task.result && Array.isArray(task.result.detail) ? task.result.detail : [];
    return detail.some((item) => Number(item && item.errno) > 0);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function isSensitiveDebugKey(key) {
    return /^(pwd|password|pass|token|cookie|authorization|auth)$/i.test(String(key || ""));
  }

  function maskSensitiveDebugValue(value) {
    if (value == null || value === "") return "[已填写]";
    if (typeof value === "string") return "*".repeat(Math.min(Math.max(value.length, 6), 12));
    return "[已填写]";
  }

  function sanitizeDebugParams(value) {
    if (Array.isArray(value)) return value.map(sanitizeDebugParams);
    if (!value || typeof value !== "object") return value;
    return Object.keys(value).reduce((result, key) => {
      result[key] = isSensitiveDebugKey(key) ? maskSensitiveDebugValue(value[key]) : sanitizeDebugParams(value[key]);
      return result;
    }, {});
  }

  function normalizeCrossDomain(value) {
    const input = String(value || "").trim();
    if (!input) return "";
    const source = /^[a-z]+:\/\//i.test(input) ? input : `https://${input}`;
    let url;
    try {
      url = new URL(source);
    } catch (error) {
      throw new Error("站点格式不正确，应为 协议://域名[:端口]");
    }
    if (!/^https?:$/i.test(url.protocol)) {
      throw new Error("仅支持 http 或 https 站点");
    }
    return `${url.protocol}//${url.host}`;
  }

  function decodeCrossRule(flag) {
    const value = Number(flag || 0);
    return {
      enabled: value === 1 || value === 3,
      cookie: value === 2 || value === 3,
    };
  }

  function encodeCrossRule(rule) {
    return (rule.enabled ? 1 : 0) + (rule.cookie ? 2 : 0);
  }

  function getCrossRules() {
    const allowCross = state.crossConfig.allow_cross || {};
    return Object.keys(allowCross)
      .sort((a, b) => a.localeCompare(b))
      .map((origin) => ({ origin, ...decodeCrossRule(allowCross[origin]) }));
  }

  function resultView(task) {
    const summary = task.result && task.result.summary ? task.result.summary : "未执行";
    const ok = !hasTaskError(task) && (task.failure_at || 0) <= (task.success_at || 0);
    return `<button class="result-link summary ${ok ? "result-ok" : "result-fail"}" type="button" data-action="detail" data-key="${escapeHtml(
      taskKey(task)
    )}">${escapeHtml(summary)}</button>`;
  }

  function actionButton(icon, action, key, title) {
    return `<button class="icon-btn" type="button" data-action="${action}" data-key="${escapeHtml(
      key
    )}" title="${escapeHtml(title)}">${icon}</button>`;
  }

  function taskRateText(task) {
    return task.cnt ? `${task.ok || 0}/${task.cnt || 0}` : "未执行";
  }

  function taskToggleTitle(task) {
    return task.enable ? "已启用" : "已禁用";
  }

  function taskActionButtons(task, key) {
    return `
      ${task.params && task.params.length ? actionButton(icons.params, "params", key, "配置参数") : ""}
      ${actionButton(icons.run, "run", key, "立即执行")}
      ${actionButton(icons.edit, "edit", key, "编辑脚本")}
      ${actionButton(icons.delete, "delete", key, "删除脚本")}
    `;
  }

  function renderTaskRow(task, key) {
    const link = taskLink(task);
    const online = onlineStatus(task);
    const rate = taskRateText(task);
    return `
      <td class="col-author">${escapeHtml(task.author || "-")}</td>
      <td class="name-cell col-name">${
        link
          ? `<a class="name-link" href="${escapeHtml(link)}" target="_blank" rel="noreferrer">${escapeHtml(task.name)}</a>`
          : `<strong>${escapeHtml(task.name)}</strong>`
      }</td>
      <td class="col-version">${escapeHtml(task.version || "-")}</td>
      <td class="col-domain"><div class="domain-list">${renderSiteCell(task)}</div></td>
      <td class="col-online ${online.className}" title="${escapeHtml(online.title || "")}">
        <button class="result-link ${online.className}" type="button" data-action="schedule" data-key="${escapeHtml(key)}">${online.text}</button>
      </td>
      <td class="col-run-at" title="${escapeHtml(formatTime(task.run_at))}">
        <button class="result-link" type="button" data-action="schedule" data-key="${escapeHtml(key)}">${formatAgo(task.run_at)}</button>
      </td>
      <td class="col-result">${resultView(task)}</td>
      <td class="col-rate"><span class="${task.cnt ? "rate" : ""}">${escapeHtml(rate)}</span></td>
      <td class="col-enabled">
        <label class="switch" title="${taskToggleTitle(task)}">
          <input type="checkbox" data-action="toggle" data-key="${escapeHtml(key)}" ${task.enable ? "checked" : ""}>
          <span></span>
        </label>
      </td>
      <td class="col-actions">
        <div class="icon-actions">${taskActionButtons(task, key)}</div>
      </td>
    `;
  }

  const icons = {
    params: '<span class="material-icons" aria-hidden="true">settings</span>',
    run: '<span class="material-icons" aria-hidden="true">play_arrow</span>',
    edit: '<span class="material-icons" aria-hidden="true">edit</span>',
    delete: '<span class="material-icons" aria-hidden="true">delete</span>',
  };

  function findTaskByKey(key) {
    return state.tasks.find((item) => taskKey(item) === key);
  }

  function extractParamsFromCode(code) {
    return String(code || "")
      .split(/\r?\n/)
      .filter((line) => /^\s*\/\/\s*@param\b/.test(line))
      .map((line) => line.replace(/^\s*\/\/\s*@param\s+/, "").trim())
      .filter(Boolean);
  }

  function extractTaskIdentityFromCode(code) {
    const lines = String(code || "").split(/\r?\n/);
    let name = "";
    let author = "";
    for (const line of lines) {
      const nameMatch = line.match(/^\s*\/\/\s*@name\s+(.+?)\s*$/);
      if (nameMatch && !name) name = nameMatch[1].trim();
      const authorMatch = line.match(/^\s*\/\/\s*@author\s+(.+?)\s*$/);
      if (authorMatch && !author) author = authorMatch[1].trim();
      if (name && author) break;
    }
    if (!name) return "";
    return `${author}/${name}`;
  }

  function highlightCode(code) {
    const source = String(code || "");
    const tokens = [];
    let i = 0;

    function push(type, text) {
      tokens.push({ type, text });
    }

    while (i < source.length) {
      const ch = source[i];
      const next = source[i + 1];
      if (ch === "/" && next === "/") {
        let j = i + 2;
        while (j < source.length && source[j] !== "\n") j++;
        push("comment", source.slice(i, j));
        i = j;
        continue;
      }

      if (ch === "/" && next === "*") {
        let j = i + 2;
        while (j < source.length - 1 && !(source[j] === "*" && source[j + 1] === "/")) j++;
        j = Math.min(source.length, j + 2);
        push("comment", source.slice(i, j));
        i = j;
        continue;
      }

      if (ch === '"' || ch === "'" || ch === "`") {
        const quote = ch;
        let j = i + 1;
        while (j < source.length) {
          if (source[j] === "\\") {
            j += 2;
            continue;
          }
          if (source[j] === quote) {
            j++;
            break;
          }
          j++;
        }
        push("string", source.slice(i, j));
        i = j;
        continue;
      }

      let j = i + 1;
      while (j < source.length) {
        const c = source[j];
        const n = source[j + 1];
        if (c === '"' || c === "'" || c === "`") break;
        if (c === "/" && (n === "/" || n === "*")) break;
        j++;
      }
      push("plain", source.slice(i, j));
      i = j;
    }

    return tokens
      .map((token) => {
        if (token.type === "comment") {
          return `<span class="tok-comment">${escapeHtml(token.text)}</span>`;
        }
        if (token.type === "string") {
          return `<span class="tok-string">${escapeHtml(token.text)}</span>`;
        }
        return escapeHtml(token.text)
          .replace(/\b(async|await|return|var|let|const|if|else|throw|try|catch|function|exports|true|false|null|undefined)\b/g, '<span class="tok-keyword">$1</span>')
          .replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-number">$1</span>')
          .replace(/\b([A-Za-z_$][\w$]*)(?=\s*\()/g, '<span class="tok-function">$1</span>');
      })
      .join("");
  }

  function syncEditorHighlight() {
    scriptHighlightEl.innerHTML = highlightCode(scriptEl.value);
    scriptHighlightEl.scrollTop = scriptEl.scrollTop;
    scriptHighlightEl.scrollLeft = scriptEl.scrollLeft;
  }

  function openEditor(title, code, taskKey) {
    editorTitle.textContent = title;
    state.editorTaskKey = taskKey || "";
    if (taskKey) {
      const task = findTaskByKey(taskKey);
      state.editorDebugParams = Object.assign({}, (task && task._params) || {});
    } else {
      state.editorDebugParams = {};
    }
    scriptEl.value = code || defaultCode;
    syncEditorHighlight();
    editorOverlay.classList.add("open");
  }

  function closeEditor() {
    state.editorTaskKey = "";
    editorOverlay.classList.remove("open");
  }

  function openConfig() {
    configOverlay.classList.add("open");
  }

  // “执行结果 / 调试结果 / 调度判定” 弹窗共用的辅助函数。
  function appendDetailRow(cells) {
    const tr = document.createElement("tr");
    tr.innerHTML = cells.map((cell) => `<td${cell.attrs || ""}>${cell.html}</td>`).join("");
    detailBody.appendChild(tr);
  }

  function resetDetailDialogState() {
    state.detailDialog = createDetailDialogState();
  }

  function setDetailHeaders(headers) {
    detailTable.classList.toggle("detail-grid-4", headers.length === 4);
    detailHeadRow.innerHTML = headers
      .map((header) => `<th${header.className ? ` class="${escapeHtml(header.className)}"` : ""}>${escapeHtml(header.label)}</th>`)
      .join("");
  }

  const DETAIL_HEADERS_4 = [
    { label: "字段", className: "detail-col-field" },
    { label: "值", className: "detail-col-value" },
    { label: "状态", className: "detail-col-status" },
    { label: "附加信息", className: "detail-col-extra" },
  ];

  function detailFieldRow(label, value, status, extra, attrs) {
    return [
      label,
      { value, attrs: attrs || "" },
      status == null ? "" : status,
      { value: extra == null ? "" : extra },
    ];
  }

  function openStructuredDetailDialog(options) {
    const opts = Object.assign(
      {
        title: "",
        summary: "",
        headers: [],
        rows: [],
      },
      options
    );
    resetDetailDialogState();
    setDetailHeaders(opts.headers);
    detailTitle.textContent = opts.title;
    detailSummary.textContent = opts.summary;
    detailBody.innerHTML = "";
    opts.rows.forEach((row) => {
      appendDetailRow([
        { attrs: ' class="detail-col-field"', html: escapeHtml(row[0] || "-") },
        {
          attrs: ` class="detail-col-value"${row[1] && row[1].attrs ? row[1].attrs : ""}`,
          html: escapeHtml(row[1] && row[1].value ? row[1].value : "-"),
        },
        { attrs: ' class="detail-col-status"', html: escapeHtml(row[2] || "-") },
        {
          attrs: ` class="detail-col-extra"${row[3] && row[3].attrs ? row[3].attrs : ""}`,
          html: escapeHtml(row[3] && row[3].value ? row[3].value : "-"),
        },
      ]);
    });
    detailOverlay.classList.add("open");
  }

  function renderSingleDomainIcon(task, domain) {
    const iconUrl = faviconUrl(task, domain);
    if (!iconUrl) return domainBadge(domain);
    return `
      <span class="domain-badge" title="${escapeHtml(domain || "")}">
        <img
          class="site-icon"
          src="${escapeHtml(iconUrl)}"
          alt="${escapeHtml(domain || "")}"
          loading="lazy"
        >
      </span>
    `;
  }

  function detailLinkFor(task, item) {
    if (item && item.url && item.url !== "#") return String(item.url);
    if (task && task.loginURL) return String(task.loginURL);
    if (item && item.domain && item.domain !== "*") return `https://${String(item.domain).replace(/^https?:\/\//i, "")}`;
    return "";
  }

  function renderDetailRows() {
    const task = state.detailDialog.task;
    const details = state.detailDialog.details;
    detailBody.innerHTML = "";
    if (!details.length) {
      appendDetailRow([{ attrs: ' colspan="3"', html: NO_DETAIL_ROWS_TEXT }]);
      return;
    }
    details.forEach((item, index) => {
      const domain = escapeHtml(item.domain || "-");
      const message = escapeHtml(item.message || "NO_MESSAGE");
      const link = detailLinkFor(task, item);
      const tr = document.createElement("tr");
      tr.innerHTML = [
        `<td class="detail-col-icon">${renderSingleDomainIcon(task, item.domain || "")}</td>`,
        `<td class="detail-col-domain detail-domain-cell"><div class="detail-domain-wrap">${
          link
            ? `<a class="domain-text" href="${escapeHtml(link)}" target="_blank" rel="noreferrer">${domain}</a>`
            : `<span class="domain-text">${domain}</span>`
        }</div></td>`,
        `<td class="detail-col-message detail-message"><button class="result-link detail-message-toggle" type="button" data-detail-toggle="${index}">${message}</button></td>`,
      ].join("");
      detailBody.appendChild(tr);
      if (state.detailDialog.expandedRows.includes(index)) {
        const extra = document.createElement("tr");
        extra.innerHTML = `<td colspan="3" class="detail-expand-cell"><pre class="detail-json">${escapeHtml(
          JSON.stringify(item, null, 2)
        )}</pre></td>`;
        detailBody.appendChild(extra);
      }
    });
  }

  function closeConfig() {
    configOverlay.classList.remove("open");
  }

  // 跨域配置相关的辅助函数。
  function renderCrossRules() {
    const rows = getCrossRules();
    crossBodyEl.innerHTML = "";
    crossEmptyEl.classList.toggle("hidden", rows.length > 0);
    rows.forEach((item) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="cross-domain">${escapeHtml(item.origin)}</td>
        <td>
          <label class="switch" title="允许携带 cookie 跨域">
            <input type="checkbox" data-cross-action="cookie" data-origin="${escapeHtml(item.origin)}" ${
              item.cookie ? "checked" : ""
            }>
            <span></span>
          </label>
        </td>
        <td>
          <label class="switch" title="${item.enabled ? "已启用" : "已禁用"}">
            <input type="checkbox" data-cross-action="enabled" data-origin="${escapeHtml(item.origin)}" ${
              item.enabled ? "checked" : ""
            }>
            <span></span>
          </label>
        </td>
        <td class="actions">
          <div class="icon-actions">
            <button class="icon-btn" type="button" data-cross-action="delete" data-origin="${escapeHtml(
              item.origin
            )}" title="删除规则">${icons.delete}</button>
          </div>
        </td>
      `;
      crossBodyEl.appendChild(tr);
    });
  }

  function openDetail(task) {
    const result = task.result || {};
    const details = Array.isArray(result.detail) ? result.detail : [];
    resetDetailDialogState();
    state.detailDialog.task = task;
    state.detailDialog.details = details.slice();
    state.detailDialog.mode = "detail";
    setDetailHeaders([
      { label: "图标", className: "detail-col-icon" },
      { label: "域名", className: "detail-col-domain" },
      { label: "消息", className: "detail-col-message" },
    ]);
    detailTitle.textContent = "细节/日志";
    detailSummary.innerHTML = `
      <div class="detail-info">
        <div class="detail-info-label">脚本名称</div>
        <div class="detail-info-value">${escapeHtml(task.name || "-")}</div>
      </div>
      <div class="detail-info">
        <div class="detail-info-label">域名列表</div>
      </div>
    `;
    renderDetailRows();
    detailOverlay.classList.add("open");
  }

  function openDebugDetail(mode, payload, error) {
    const now = Date.now();
    const data = payload && typeof payload === "object" ? payload : null;
    const startedAt = data && data.started_at ? Number(data.started_at) : now;
    const endedAt = data && data.ended_at ? Number(data.ended_at) : now;
    const duration = data && data.duration_ms != null ? data.duration_ms : Math.max(0, endedAt - startedAt);
    const preWrapAttrs = ' class="detail-prewrap"';
    const rows = [
      detailFieldRow("模式", String(mode || "-").toUpperCase(), error ? "失败" : "成功", ""),
      detailFieldRow("脚本", data && data.key ? data.key : "-", "", ""),
      detailFieldRow("开始时间", formatTime(startedAt), "", `${startedAt}`),
      detailFieldRow("结束时间", formatTime(endedAt), "", `${endedAt}`),
      detailFieldRow("耗时", `${duration} ms`, "", ""),
      detailFieldRow("超时限制", `${data && data.timeout_ms != null ? data.timeout_ms : "-"} ms`, "", ""),
      detailFieldRow("调试参数", data ? JSON.stringify(sanitizeDebugParams(data.params || {}), null, 2) : "{}", "", "", preWrapAttrs),
      detailFieldRow("返回结果", error ? "-" : JSON.stringify(data ? data.value : payload, null, 2), error ? "未返回" : "已返回", "", preWrapAttrs),
      detailFieldRow("错误信息", error ? String(error) : "-", error ? "异常" : "-", "", preWrapAttrs),
    ];

    openStructuredDetailDialog({
      title: `调试${String(mode || "").toUpperCase()}结果`,
      summary: error
        ? "本次调试执行失败，下面是错误和上下文信息。"
        : "本次调试执行完成，下面是返回值和耗时信息。",
      headers: DETAIL_HEADERS_4,
      rows,
    });
  }
  async function openScheduleDebug(task) {
    const config = await send(MESSAGE_PATHS.configGet);
    const now = Date.now();
    const beginAt = normalizeBeginAtHours(config.begin_at);
    const today = getDayStartTimestamp(now, beginAt);
    const successAt = Number(task.success_at || 0);
    const failureAt = Number(task.failure_at || 0);
    const onlineAt = Number(task.online_at || 0);
    const freq = Number(task.freq || 0);
    const onlineRecheckMs = getOnlineRecheckMs(task);
    const onlineRecheckSource = Number(task.expire) > 0 ? "@expire" : "全局兜底";
    const done = !freq || freq >= 86400000 ? successAt >= today : successAt + freq >= now;
    const due = !done;
    const retryable = failureAt + Number(config.retry_freq || 0) * 1000 <= now;

    const rows = [
      detailFieldRow("当前时间", formatTimeSeconds(now), "", `${now}`),
      detailFieldRow("新一天起点", formatTimeSeconds(today), "", `begin_at=${beginAt}时`),
      detailFieldRow("last_refresh", formatTimeSeconds(Number(config.last_refresh_at || 0)), String(config.last_refresh_reason || "-"), `${Number(config.last_refresh_at || 0)}`),
      detailFieldRow("last_refresh_done", formatTimeSeconds(Number(config.last_refresh_done_at || 0)), String(config.last_refresh_done_reason || "-"), `${Number(config.last_refresh_done_at || 0)}`),
      detailFieldRow("last_refresh_stage", String(config.last_refresh_stage || "-"), "", String(config.last_refresh_error || "-")),
      detailFieldRow("success_at", formatTimeSeconds(successAt), successAt >= today ? "今天已成功" : "今天未成功", `${successAt}`),
      detailFieldRow("failure_at", formatTimeSeconds(failureAt), failureAt > successAt ? "最近一次失败" : "无新失败", `${failureAt}`),
      detailFieldRow("online_at", formatTimeSeconds(onlineAt), onlineAt < 0 ? "离线" : onlineAt > 0 ? "在线" : "未检查", `${onlineAt}`),
      detailFieldRow("在线复查间隔", `${Math.round(onlineRecheckMs / 1000)} s`, onlineRecheckSource, ""),
      detailFieldRow("freq", freq ? `${freq} ms` : "按天判断", done ? "done=true" : "done=false", due ? "due=true" : "due=false"),
      detailFieldRow("retry_freq", `${Number(config.retry_freq || 0)} s`, retryable ? "retryable=true" : "retryable=false", ""),
    ];

    openStructuredDetailDialog({
      title: `${taskKey(task)} - 调度判定`,
      summary: "查看当前任务为什么会被判定为已完成、待执行或离线。",
      headers: DETAIL_HEADERS_4,
      rows,
    });
  }

  function closeDetail() {
    resetDetailDialogState();
    detailOverlay.classList.remove("open");
  }

  function parseParamSpec(raw) {
    const text = String(raw || "").trim();
    if (!text) return null;
    const parts = text.split(/\s+/);
    let name = parts.shift() || "";
    let type = "text";
    const label = parts.join(" ") || name;
    if (name.includes(":")) {
      const pair = name.split(":");
      name = pair[0] || name;
      type = pair[1] || type;
    }
    if (/pwd|pass|password/i.test(name) || /password/i.test(label)) type = "password";
    else if (/mail/i.test(name)) type = "email";
    else if (/count|num|number/i.test(name)) type = "number";
    else if (/bool|boolean|enable|enabled|switch|on/i.test(name)) type = "checkbox";
    return { name, type, label };
  }

  function appendParamField(spec, value) {
    const wrap = document.createElement("label");
    wrap.className = "param-field";
    if (spec.type === "checkbox") {
      wrap.innerHTML = `${escapeHtml(spec.label)}<input type="checkbox" data-param="${escapeHtml(spec.name)}" ${
        value ? "checked" : ""
      }>`;
    } else {
      wrap.innerHTML = `${escapeHtml(spec.label)}<input type="${escapeHtml(spec.type)}" data-param="${escapeHtml(
        spec.name
      )}" value="${escapeHtml(value == null ? "" : value)}">`;
    }
    paramsFields.appendChild(wrap);
  }

  function renderParamFields(params, values, emptyHtml) {
    paramsFields.innerHTML = "";
    if (!params.length) {
      paramsFields.innerHTML = emptyHtml;
      return;
    }
    params.forEach((raw) => {
      const spec = parseParamSpec(raw);
      if (!spec) return;
      appendParamField(spec, values[spec.name]);
    });
  }

  function openParamsDialog(title, taskKeyValue, params, values, emptyHtml) {
    state.paramsTaskKey = taskKeyValue;
    paramsTitle.textContent = title;
    renderParamFields(params, values, emptyHtml);
    paramsOverlay.classList.add("open");
  }

  function openParams(task) {
    openParamsDialog(
      task.name || taskKey(task),
      taskKey(task),
      Array.isArray(task.params) ? task.params : [],
      task._params || {},
      "<div>当前脚本没有可配置参数</div>"
    );
  }

  function openDebugParams() {
    openParamsDialog(
      "调试参数",
      "__editor_debug__",
      extractParamsFromCode(scriptEl.value),
      state.editorDebugParams,
      "<div>当前脚本没有声明 @param 参数</div>"
    );
  }

  function closeParams() {
    paramsOverlay.classList.remove("open");
  }

  // 录制脚本流程相关的辅助函数。
  function openRecord() {
    recordUrlEl.value = "";
    recordOverlay.classList.add("open");
    setTimeout(() => recordUrlEl.focus(), 0);
  }

  function closeRecord() {
    recordOverlay.classList.remove("open");
  }

  function applyCrossConfig(config) {
    state.crossConfig = {
      cross_header: String((config && config.cross_header) || ""),
      allow_cross: Object.assign({}, (config && config.allow_cross) || {}),
      cross: Boolean(config && config.cross),
    };
    crossHeaderEl.value = state.crossConfig.cross_header;
    crossDomainEl.value = "";
    renderCrossRules();
  }

  function buildCrossConfigPayload() {
    state.crossConfig.cross_header = String(crossHeaderEl.value || "").trim();
    return {
      cross_header: state.crossConfig.cross_header,
      allow_cross: Object.assign({}, state.crossConfig.allow_cross || {}),
      cross: getCrossRules().length > 0,
    };
  }

  function collectParamValues() {
    const payload = {};
    paramsFields.querySelectorAll("[data-param]").forEach((el) => {
      payload[el.dataset.param] = el.type === "checkbox" ? el.checked : el.value;
    });
    return payload;
  }

  async function saveParams() {
    const payload = collectParamValues();
    if (state.paramsTaskKey === "__editor_debug__") {
      state.editorDebugParams = Object.assign({}, state.editorDebugParams, payload);
      closeParams();
      showToast("调试参数已保存");
      return;
    }
    const task = findTaskByKey(state.paramsTaskKey);
    if (!task) return;
    task._params = Object.assign({}, task._params || {}, payload);
    await send(MESSAGE_PATHS.taskSet, {
      author: task.author,
      name: task.name,
      _params: task._params,
    });
    closeParams();
    await refresh();
    showToast("参数已保存");
  }

  async function loadConfig() {
    const config = await send(MESSAGE_PATHS.configGet);
    applyCrossConfig(config);
  }

  async function saveConfig() {
    const payload = buildCrossConfigPayload();
    await send(MESSAGE_PATHS.configSet, payload);
    showToast("跨域配置已保存");
    state.crossConfig.cross = payload.cross;
    closeConfig();
  }

  async function persistCrossConfig(message) {
    const payload = buildCrossConfigPayload();
    await send(MESSAGE_PATHS.configSet, payload);
    state.crossConfig.cross = payload.cross;
    renderCrossRules();
    if (message) showToast(message);
  }

  async function addCrossRule() {
    const origin = normalizeCrossDomain(crossDomainEl.value);
    const current = decodeCrossRule((state.crossConfig.allow_cross || {})[origin]);
    state.crossConfig.allow_cross = Object.assign({}, state.crossConfig.allow_cross, {
      [origin]: encodeCrossRule({ enabled: true, cookie: current.cookie }),
    });
    crossDomainEl.value = "";
    await persistCrossConfig(`已添加 ${origin}`);
  }

  function renderTasks() {
    emptyState.classList.toggle("hidden", state.tasks.length > 0);
    const nextRows = new Map();
    const fragment = document.createDocumentFragment();
    state.tasks.forEach((task) => {
      const key = taskKey(task);
      const tr = state.taskRowMap.get(key) || document.createElement("tr");
      tr.dataset.taskKey = key;
      tr.innerHTML = renderTaskRow(task, key);
      nextRows.set(key, tr);
      fragment.appendChild(tr);
    });
    taskBody.replaceChildren(fragment);
    state.taskRowMap = nextRows;
  }

  async function refresh() {
    state.tasks = await send(MESSAGE_PATHS.taskList);
    renderTasks();
  }

  async function requestRefresh(options) {
    const opts = Object.assign({ force: false, minInterval: 0 }, options);
    const now = Date.now();
    if (!opts.force && opts.minInterval > 0 && now - state.lastRefreshAt < opts.minInterval) {
      return state.refreshPromise || Promise.resolve(state.tasks);
    }
    if (state.refreshPromise) {
      state.refreshQueued = true;
      return state.refreshPromise;
    }
    state.refreshPromise = (async () => {
      try {
        await refresh();
        state.lastRefreshAt = Date.now();
      } finally {
        state.refreshPromise = null;
      }
      if (state.refreshQueued) {
        state.refreshQueued = false;
        return requestRefresh({ force: true });
      }
      return state.tasks;
    })();
    return state.refreshPromise;
  }

  async function refreshViewAfterMutation() {
    return requestRefresh({ force: true });
  }

  // 主列表里各类任务按钮触发的动作。
  function isTaskDoneInCurrentWindow(task, config, now) {
    const beginAt = normalizeBeginAtHours((config && config.begin_at) || 0);
    const today = getDayStartTimestamp(now, beginAt);
    const successAt = Number(task && task.success_at || 0);
    const freq = Number(task && task.freq || 0);
    return !freq || freq >= 86400000 ? successAt >= today : successAt + freq >= now;
  }

  function startAutoRefresh() {
    clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(() => {
      if (document.hidden) return;
      requestRefresh({ minInterval: 2500 }).catch(() => {});
    }, 3000);
  }

  async function refreshOnlineStatus(force) {
    if (state.checkingOnline) return;
    const now = Date.now();
    const config = force ? null : await send(MESSAGE_PATHS.configGet);
    const queue = state.tasks.filter((task) => {
      if (!task.enable) return false;
      if (force) return true;
      if (isTaskDoneInCurrentWindow(task, config, now)) return false;
      return !task.online_at;
    });
    if (!queue.length) return;
    state.checkingOnline = true;
    try {
      for (const task of queue) {
        await send(MESSAGE_PATHS.taskCheck, taskKey(task));
      }
      await refresh();
    } finally {
      state.checkingOnline = false;
    }
  }

  async function runTask(key) {
    await send(MESSAGE_PATHS.taskRun, key);
    await refreshViewAfterMutation();
    showToast(`已执行 ${key}`);
  }

  async function toggleTask(key, enabled) {
    const task = findTaskByKey(key);
    if (!task) return;
    task.enable = enabled;
    await send(MESSAGE_PATHS.taskSet, task);
    if (enabled) {
      await send(MESSAGE_PATHS.taskCheck, key).catch(() => {});
      await refreshViewAfterMutation();
    }
    showToast(`${enabled ? "已启用" : "已禁用"} ${key}`);
  }

  async function deleteTask(key) {
    if (!confirm(`确定删除 ${key} 吗？`)) return;
    await send(MESSAGE_PATHS.taskDelete, key);
    await refreshViewAfterMutation();
    showToast(`已删除 ${key}`);
  }

  async function clearCount() {
    if (!state.tasks.length) return;
    for (const task of state.tasks) {
      await send(MESSAGE_PATHS.taskSet, {
        author: task.author,
        name: task.name,
        ok: 0,
        cnt: 0,
        success_at: 0,
        failure_at: 0,
        run_at: 0,
      });
    }
    await refreshViewAfterMutation();
    showToast("统计已清空");
  }

  async function saveScript() {
    const code = scriptEl.value.trim();
    if (!code) throw new Error("脚本内容不能为空");
    const savedKey = extractTaskIdentityFromCode(code);
    const originalKey = state.editorTaskKey || "";
    const originalTask = originalKey ? findTaskByKey(originalKey) : null;
    const previousTask = originalTask || (savedKey ? findTaskByKey(savedKey) : null);
    await send(MESSAGE_PATHS.taskAdd, code);
    if (previousTask) {
      await send(MESSAGE_PATHS.taskSet, {
        author: (savedKey || "").split("/")[0] || previousTask.author,
        name: (savedKey || "").split("/").slice(1).join("/") || previousTask.name,
        enable: previousTask.enable,
        _params: previousTask._params || {},
        ok: previousTask.ok || 0,
        cnt: previousTask.cnt || 0,
        success_at: previousTask.success_at || 0,
        failure_at: previousTask.failure_at || 0,
        run_at: previousTask.run_at || 0,
        online_at: previousTask.online_at || 0,
        result: previousTask.result || undefined,
      });
    }
    if (originalKey && savedKey && originalKey !== savedKey) {
      await send(MESSAGE_PATHS.taskDelete, originalKey);
    }
    closeEditor();
    await refreshViewAfterMutation();
    if (savedKey) {
      const savedTask = findTaskByKey(savedKey);
      if (savedTask && savedTask.enable) {
        await refreshViewAfterMutation();
      }
    }
    showToast("脚本已保存");
  }

  async function debugTask(mode) {
    const code = scriptEl.value.trim();
    if (!code) throw new Error("脚本内容不能为空");
    try {
      const result = await send(MESSAGE_PATHS.taskDebug, {
        mode,
        code,
        params: state.editorDebugParams,
        timeout: DEBUG_TIMEOUT_MS,
      });
      openDebugDetail(mode, result, "");
    } catch (error) {
      openDebugDetail(mode, null, error);
    }
  }

  async function exportScripts() {
    const payload = {
      exported_at: new Date().toISOString(),
      config: await send(MESSAGE_PATHS.configGet),
      tasks: await send(MESSAGE_PATHS.taskList),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFileName();
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importScripts(file) {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const tasks = Array.isArray(parsed) ? parsed : Array.isArray(parsed.tasks) ? parsed.tasks : [];
    if (!tasks.length) throw new Error("导入文件中没有可用脚本");
    if (parsed.config) {
      await send(MESSAGE_PATHS.configSet, parsed.config);
      await loadConfig();
    }
    for (const task of tasks) {
      await send(MESSAGE_PATHS.taskAdd, task.code || task);
      if (task._params || typeof task.enable === "boolean" || task.ok || task.cnt || task.result) {
        await send(MESSAGE_PATHS.taskSet, {
          author: task.author,
          name: task.name,
          _params: task._params || {},
          enable: typeof task.enable === "boolean" ? task.enable : true,
          ok: task.ok || 0,
          cnt: task.cnt || 0,
          success_at: task.success_at || 0,
          failure_at: task.failure_at || 0,
          run_at: task.run_at || 0,
          online_at: task.online_at || 0,
          result: task.result || undefined,
        });
      }
    }
    await refreshViewAfterMutation();
    showToast(`已导入 ${tasks.length} 个脚本`);
  }

  async function finishRecord() {
    if (!state.recording || state.finishingRecord) return;
    state.finishingRecord = true;
    try {
      const code = await send(MESSAGE_PATHS.recordEnd);
      state.recording = false;
      window.onfocus = null;
      openEditor("录制脚本", typeof code === "string" && code.trim() ? code : defaultCode);
    } finally {
      state.finishingRecord = false;
    }
  }

  async function startRecord() {
    const url = String(recordUrlEl.value || "").trim();
    if (!url) throw new Error("请输入签到网址");
    closeRecord();
    state.recording = true;
    state.finishingRecord = false;
    await send(MESSAGE_PATHS.recordStart, { url });
    window.onfocus = async () => {
      await finishRecord().catch(reportError);
    };
    showToast("录制已开始，请在新页面完成操作");
  }

  async function handleTaskAction(action, key) {
    if (action === "run") {
      await runTask(key);
      return;
    }
    const task = findTaskByKey(key);
    if (!task && action !== "delete") return;
    if (action === "edit") {
      openEditor(`编辑脚本: ${task.name || key}`, task.code || defaultCode, key);
    } else if (action === "detail") {
      openDetail(task);
    } else if (action === "schedule") {
      await openScheduleDebug(task);
    } else if (action === "delete") {
      await deleteTask(key);
    } else if (action === "params") {
      openParams(task);
    }
  }

  taskBody.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const key = button.dataset.key;
    const action = button.dataset.action;
    try {
      await handleTaskAction(action, key);
    } catch (error) {
      reportError(error);
    }
  });

  taskBody.addEventListener("change", async (event) => {
    const input = event.target.closest('input[data-action="toggle"]');
    if (!input) return;
    try {
      await toggleTask(input.dataset.key, input.checked);
    } catch (error) {
      input.checked = !input.checked;
      reportError(error);
    }
  });

  bindAsyncClick("nav-config", () => loadConfig().then(openConfig));
  document.getElementById("add-script").addEventListener("click", () => openEditor("添加脚本", defaultCode));
  document.getElementById("record-script").addEventListener("click", openRecord);
  document.getElementById("import-script").addEventListener("click", () => fileInput.click());
  bindAsyncClick("export-script", exportScripts);
  bindAsyncClick("clear-count", clearCount);
  bindAsyncClick("save-script", saveScript);
  document.getElementById("debug-params").addEventListener("click", openDebugParams);
  bindAsyncClick("debug-check", () => debugTask("check"));
  bindAsyncClick("debug-run", () => debugTask("run"));
  document.getElementById("close-editor").addEventListener("click", closeEditor);
  document.getElementById("cancel-editor").addEventListener("click", closeEditor);
  closeConfigEl.addEventListener("click", closeConfig);
  cancelConfigEl.addEventListener("click", closeConfig);
  document.getElementById("close-detail").addEventListener("click", closeDetail);
  document.getElementById("close-detail-action").addEventListener("click", closeDetail);
  detailBody.addEventListener("click", (event) => {
    const button = event.target.closest("[data-detail-toggle]");
    if (!button || state.detailDialog.mode !== "detail") return;
    const index = Number(button.dataset.detailToggle);
    const expanded = new Set(state.detailDialog.expandedRows);
    if (expanded.has(index)) expanded.delete(index);
    else expanded.add(index);
    state.detailDialog.expandedRows = Array.from(expanded).sort((a, b) => a - b);
    renderDetailRows();
  });
  document.getElementById("close-params").addEventListener("click", closeParams);
  document.getElementById("cancel-params").addEventListener("click", closeParams);
  document.getElementById("close-record").addEventListener("click", closeRecord);
  document.getElementById("cancel-record").addEventListener("click", closeRecord);
  bindAsyncClick("confirm-record", startRecord);
  document.getElementById("save-params").addEventListener("click", () => {
    saveParams().catch(reportError);
  });
  saveConfigEl.addEventListener("click", () => {
    saveConfig().catch(reportError);
  });
  addCrossEl.addEventListener("click", () => {
    addCrossRule().catch(reportError);
  });
  crossDomainEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addCrossRule().catch(reportError);
  });
  crossBodyEl.addEventListener("change", (event) => {
    const input = event.target.closest("[data-cross-action]");
    if (!input) return;
    const action = input.dataset.crossAction;
    const origin = input.dataset.origin;
    const allowCross = Object.assign({}, state.crossConfig.allow_cross || {});
    const current = decodeCrossRule(allowCross[origin]);
    if (action === "cookie") current.cookie = input.checked;
    if (action === "enabled") current.enabled = input.checked;
    allowCross[origin] = encodeCrossRule(current);
    state.crossConfig.allow_cross = allowCross;
    persistCrossConfig().catch(reportError);
  });
  crossBodyEl.addEventListener("click", (event) => {
    const button = event.target.closest('[data-cross-action="delete"]');
    if (!button) return;
    const origin = button.dataset.origin;
    const allowCross = Object.assign({}, state.crossConfig.allow_cross || {});
    delete allowCross[origin];
    state.crossConfig.allow_cross = allowCross;
    persistCrossConfig(`已删除 ${origin}`).catch(reportError);
  });

  // 编辑脚本时禁止点击遮罩层误关闭，避免未保存内容丢失。
  editorOverlay.addEventListener("click", (event) => {
    if (event.target === editorOverlay) {
      event.stopPropagation();
    }
  });
  configOverlay.addEventListener("click", (event) => {
    if (event.target === configOverlay) closeConfig();
  });
  detailOverlay.addEventListener("click", (event) => {
    if (event.target === detailOverlay) closeDetail();
  });
  paramsOverlay.addEventListener("click", (event) => {
    if (event.target === paramsOverlay) closeParams();
  });
  recordOverlay.addEventListener("click", (event) => {
    if (event.target === recordOverlay) closeRecord();
  });

  fileInput.addEventListener("change", async () => {
    const file = (fileInput.files || [])[0];
    fileInput.value = "";
    if (!file) return;
    try {
      await importScripts(file);
    } catch (error) {
      reportError(error);
    }
  });

  scriptEl.addEventListener("input", syncEditorHighlight);
  scriptEl.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    const indent = "  ";
    const start = scriptEl.selectionStart;
    const end = scriptEl.selectionEnd;
    const value = scriptEl.value;
    if (event.shiftKey) {
      const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
      const selectedText = value.slice(start, end);
      const hasSelection = start !== end && selectedText.includes("\n");
      if (!hasSelection) {
        if (value.slice(lineStart, lineStart + indent.length) === indent) {
          scriptEl.value = value.slice(0, lineStart) + value.slice(lineStart + indent.length);
          const offset = Math.min(indent.length, start - lineStart);
          scriptEl.selectionStart = start - offset;
          scriptEl.selectionEnd = end - offset;
        }
      } else {
        const lineEnd = value.indexOf("\n", end);
        const blockEnd = lineEnd === -1 ? value.length : lineEnd;
        const block = value.slice(lineStart, blockEnd);
        const lines = block.split("\n");
        let removed = 0;
        const updated = lines
          .map((line) => {
            if (line.startsWith(indent)) {
              removed += indent.length;
              return line.slice(indent.length);
            }
            if (line.startsWith("\t")) {
              removed += 1;
              return line.slice(1);
            }
            return line;
          })
          .join("\n");
        scriptEl.value = value.slice(0, lineStart) + updated + value.slice(blockEnd);
        scriptEl.selectionStart = lineStart;
        scriptEl.selectionEnd = Math.max(lineStart, end - removed);
      }
    } else if (start !== end && value.slice(start, end).includes("\n")) {
      const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
      const lineEnd = value.indexOf("\n", end);
      const blockEnd = lineEnd === -1 ? value.length : lineEnd;
      const block = value.slice(lineStart, blockEnd);
      const lines = block.split("\n").map((line) => indent + line);
      scriptEl.value = value.slice(0, lineStart) + lines.join("\n") + value.slice(blockEnd);
      scriptEl.selectionStart = lineStart;
      scriptEl.selectionEnd = end + indent.length * lines.length;
    } else {
      scriptEl.value = value.slice(0, start) + indent + value.slice(end);
      scriptEl.selectionStart = scriptEl.selectionEnd = start + indent.length;
    }
    syncEditorHighlight();
  });
  scriptEl.addEventListener("scroll", () => {
    scriptHighlightEl.scrollTop = scriptEl.scrollTop;
    scriptHighlightEl.scrollLeft = scriptEl.scrollLeft;
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      requestRefresh({ minInterval: 1000 }).catch(() => {});
      if (state.recording && typeof window.onfocus === "function") {
        Promise.resolve(window.onfocus()).catch(reportError);
      }
    }
  });

  (async function init() {
    // 页面初始化：同步文案、读取配置、渲染任务列表并启动自动刷新。
    const manifest = chrome.runtime.getManifest();
    const configTitle = configOverlay.querySelector(".modal-title");
    if (versionEl && manifest && manifest.version) versionEl.textContent = manifest.version;
    if (configTitle) configTitle.textContent = "跨域管理";
    if (cancelConfigEl) cancelConfigEl.textContent = "关闭";
    if (saveConfigEl) saveConfigEl.textContent = "保存配置";
    if (addCrossEl) addCrossEl.textContent = "添加";
    await loadConfig();
    await refresh();
    startAutoRefresh();
    await refreshOnlineStatus(false);
  })().catch((error) => {
    reportError(error);
  });
})();
