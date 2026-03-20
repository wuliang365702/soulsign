(function () {
  const MESSAGE_PATHS = {
    configGet: "config/get",
    configSet: "config/set",
  };

  const SETTINGS_TAB = "settings";
  const HELPER_TAB = "helper";
  const DEFAULT_FORM_VALUES = {
    local_notify: true,
    notify_freq: 1800,
    retry_freq: 600,
    loop_freq: 3600,
    begin_at: 0,
    upgrade: false,
    upgrade_freq: 86400,
    timeout: 60,
    notify_url: "",
  };
  const fieldIds = [
    "local_notify",
    "notify_freq",
    "retry_freq",
    "loop_freq",
    "begin_at",
    "upgrade",
    "upgrade_freq",
    "timeout",
    "notify_url",
  ];
  const COOKIE_TEXT_INDENT = 2;

  const state = {
    activeTab: SETTINGS_TAB,
    helperUrl: "",
    helperCookiesLoaded: false,
  };

  const statusEl = document.getElementById("status");
  const settingsPanel = document.getElementById("settings-panel");
  const helperPanel = document.getElementById("helper-panel");
  const helperUrlEl = document.getElementById("helper-url");
  const cookieTextarea = document.getElementById("cookie-textarea");
  const settingsTabButton = document.getElementById("open-settings");
  const helperTabButton = document.getElementById("open-helper");

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

  function setStatus(message, isError) {
    statusEl.textContent = message || "";
    statusEl.style.color = isError ? "#dc2626" : "#6b7280";
  }

  function reportStatusError(error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(message, true);
  }

  function bindAsyncClick(id, handler) {
    document.getElementById(id).addEventListener("click", () => {
      Promise.resolve(handler()).catch(reportStatusError);
    });
  }

  function clampBeginAt(value) {
    const raw = Number(value || 0);
    if (!Number.isFinite(raw) || raw < 0) return 0;
    return Math.min(24, raw);
  }

  function applyDefaultPlaceholders() {
    fieldIds.forEach((id) => {
      const el = document.getElementById(id);
      if (!el || el.type !== "number") return;
      if (!(id in DEFAULT_FORM_VALUES)) return;
      el.placeholder = `默认${DEFAULT_FORM_VALUES[id]}`;
    });
  }

  function fillForm(config) {
    fieldIds.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (el.type === "checkbox") {
        el.checked = !!config[id];
      } else {
        const value = id === "begin_at" ? clampBeginAt(config[id]) : config[id];
        el.value = value == null ? "" : String(value);
      }
    });
  }

  function readForm() {
    const payload = {};
    fieldIds.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (el.type === "checkbox") {
        payload[id] = !!el.checked;
      } else if (el.type === "number") {
        const raw = String(el.value || "").trim();
        const value = raw === "" ? DEFAULT_FORM_VALUES[id] : Number(raw);
        payload[id] = id === "begin_at" ? clampBeginAt(value) : value;
      } else {
        payload[id] = el.value.trim();
      }
    });
    return payload;
  }

  function setActiveTab(tab) {
    state.activeTab = tab;
    settingsPanel.classList.toggle("active", tab === SETTINGS_TAB);
    helperPanel.classList.toggle("active", tab === HELPER_TAB);
    settingsTabButton.classList.toggle("active", tab === SETTINGS_TAB);
    helperTabButton.classList.toggle("active", tab === HELPER_TAB);
    setStatus("");
  }

  function isSupportedCookieUrl(url) {
    return /^https?:\/\//i.test(url || "");
  }

  function getCurrentActiveTab() {
    return new Promise((resolve, reject) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve((tabs && tabs[0]) || null);
      });
    });
  }

  function getCookiesByUrl(url) {
    return new Promise((resolve, reject) => {
      chrome.cookies.getAll({ url }, (cookies) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(cookies || []);
      });
    });
  }

  function removeCookie(details) {
    return new Promise((resolve, reject) => {
      chrome.cookies.remove(details, (removed) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(removed);
      });
    });
  }

  function setCookie(details) {
    return new Promise((resolve, reject) => {
      chrome.cookies.set(details, (cookie) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(cookie);
      });
    });
  }

  function helperCookieUrl(cookie, currentUrl) {
    if (cookie && cookie.url) return cookie.url;
    const current = new URL(currentUrl);
    const hostname = String((cookie && cookie.domain) || current.hostname).replace(/^\./, "");
    const protocol = cookie && cookie.secure ? "https:" : current.protocol;
    const path = cookie && cookie.path ? cookie.path : "/";
    return `${protocol}//${hostname}${path.startsWith("/") ? path : `/${path}`}`;
  }

  function serializeCookies(cookies, currentUrl) {
    return JSON.stringify(
      cookies.map((cookie) => {
        const serialized = {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          secure: !!cookie.secure,
          httpOnly: !!cookie.httpOnly,
          hostOnly: !!cookie.hostOnly,
          session: !!cookie.session,
          sameSite: cookie.sameSite || "unspecified",
          storeId: cookie.storeId || "",
          url: helperCookieUrl(cookie, currentUrl),
        };
        if (Number.isFinite(cookie.expirationDate)) {
          serialized.expirationDate = cookie.expirationDate;
        }
        if (cookie.partitionKey) {
          serialized.partitionKey = cookie.partitionKey;
        }
        return serialized;
      }),
      null,
      COOKIE_TEXT_INDENT
    );
  }

  function parseCookiePairs(text, currentUrl) {
    return text
      .split(/;\s*\n?|;\s*/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const index = entry.indexOf("=");
        if (index <= 0) {
          throw new Error(`无法解析 cookie：${entry}`);
        }
        const name = entry.slice(0, index).trim();
        const value = entry.slice(index + 1).trim();
        return { name, value, url: currentUrl };
      });
  }

  function normalizeCookieForSet(cookie, currentUrl) {
    if (!cookie || typeof cookie !== "object") {
      throw new Error("cookie 数据格式无效");
    }
    if (!cookie.name) {
      throw new Error("cookie 缺少 name");
    }

    const details = {
      url: helperCookieUrl(cookie, currentUrl),
      name: String(cookie.name),
      value: cookie.value == null ? "" : String(cookie.value),
    };

    const hostOnly = !!cookie.hostOnly;
    if (cookie.domain && !hostOnly) details.domain = String(cookie.domain);
    if (cookie.path) details.path = String(cookie.path);
    if (cookie.storeId) details.storeId = String(cookie.storeId);
    if (typeof cookie.secure === "boolean") details.secure = cookie.secure;
    if (typeof cookie.httpOnly === "boolean") details.httpOnly = cookie.httpOnly;
    if (cookie.sameSite) details.sameSite = cookie.sameSite;
    if (!cookie.session && Number.isFinite(cookie.expirationDate)) {
      details.expirationDate = cookie.expirationDate;
    }
    if (cookie.partitionKey) {
      details.partitionKey = cookie.partitionKey;
    }
    return details;
  }

  function parseCookieText(text, currentUrl) {
    const content = String(text || "").trim();
    if (!content) return [];
    try {
      const parsed = JSON.parse(content);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list.map((cookie) => normalizeCookieForSet(cookie, currentUrl));
    } catch (error) {
      return parseCookiePairs(content, currentUrl).map((cookie) => normalizeCookieForSet(cookie, currentUrl));
    }
  }

  async function loadConfig() {
    const config = await send(MESSAGE_PATHS.configGet);
    fillForm(config);
    setStatus("");
  }

  async function saveConfig() {
    await send(MESSAGE_PATHS.configSet, readForm());
    setStatus("配置已保存", false);
  }

  async function loadHelperCookies(force) {
    if (state.helperCookiesLoaded && !force) return;
    const tab = await getCurrentActiveTab();
    const url = tab && tab.url ? tab.url : "";
    state.helperUrl = url;
    helperUrlEl.textContent = url ? `当前标签页：${url}` : "未找到活动标签页";

    if (!isSupportedCookieUrl(url)) {
      cookieTextarea.value = "";
      state.helperCookiesLoaded = false;
      throw new Error("当前标签页不支持读取 cookie");
    }

    const cookies = await getCookiesByUrl(url);
    cookieTextarea.value = serializeCookies(cookies, url);
    state.helperCookiesLoaded = true;
    setStatus(`已读取当前站点 cookie（${cookies.length} 条）`, false);
  }

  async function saveHelperCookies() {
    const currentUrl = state.helperUrl || (await getCurrentActiveTab()).url || "";
    if (!isSupportedCookieUrl(currentUrl)) {
      throw new Error("当前标签页不支持写入 cookie");
    }

    const existingCookies = await getCookiesByUrl(currentUrl);
    await Promise.all(
      existingCookies.map((cookie) =>
        removeCookie({
          url: helperCookieUrl(cookie, currentUrl),
          name: cookie.name,
          storeId: cookie.storeId,
          partitionKey: cookie.partitionKey,
        }).catch(() => null)
      )
    );

    const cookies = parseCookieText(cookieTextarea.value, currentUrl);
    await Promise.all(cookies.map((cookie) => setCookie(cookie)));
    state.helperCookiesLoaded = true;
    setStatus(cookies.length ? `已保存 ${cookies.length} 条 cookie` : "已清空当前站点 cookie", false);
  }

  async function clearHelperCookies() {
    cookieTextarea.value = "";
    await saveHelperCookies();
  }

  async function copyHelperCookies() {
    await navigator.clipboard.writeText(cookieTextarea.value || "");
    setStatus("cookie 已复制", false);
  }

  document.getElementById("restart-extension").addEventListener("click", () => {
    chrome.runtime.reload();
  });

  settingsTabButton.addEventListener("click", () => {
    setActiveTab(SETTINGS_TAB);
  });

  helperTabButton.addEventListener("click", () => {
    setActiveTab(HELPER_TAB);
    loadHelperCookies(true).catch(reportStatusError);
  });

  bindAsyncClick("save", saveConfig);
  bindAsyncClick("clear-cookie", clearHelperCookies);
  bindAsyncClick("copy-cookie", copyHelperCookies);
  bindAsyncClick("save-cookie", saveHelperCookies);

  document.getElementById("open-options").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  applyDefaultPlaceholders();
  loadConfig().catch(reportStatusError);
})();
