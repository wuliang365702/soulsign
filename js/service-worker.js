const OFFSCREEN_URL = "offscreen.html";
const HOURLY_ALARM_NAME = "soulsign-hourly";
const STARTUP_ALARM_NAME = "soulsign-startup";
const DEFAULT_LOOP_FREQ_SECONDS = 3600;
const MIN_LOOP_FREQ_SECONDS = 60;
const notificationTargets = new Map();
let lastWakeRefreshAt = 0;
let offscreenCreating = null;

function executeSoulsignEval(source, id) {
  return new Promise((resolve) => {
    const eventName = "__soulsign_result_" + id;
    function done(event) {
      document.removeEventListener(eventName, done);
      resolve(event.detail);
    }
    document.addEventListener(eventName, done, { once: true });
    const script = document.createElement("script");
    script.textContent = `
      (async function () {
        let detail;
        try {
          detail = { ok: true, value: await (async () => (${source}))() };
        } catch (error) {
          detail = { ok: false, error: String(error) };
        }
        document.dispatchEvent(new CustomEvent(${JSON.stringify(eventName)}, { detail }));
      })();
    `;
    (document.documentElement || document.head).appendChild(script);
    script.remove();
  });
}

function getStorageArea(area) {
  return chrome.storage[area] || chrome.storage.local;
}

function createTab(details) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(details, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tab);
    });
  });
}

function getTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tab);
    });
  });
}

async function ensureOffscreen() {
  if (offscreenCreating) return offscreenCreating;
  if (await hasOffscreenDocument()) {
    return;
  }
  offscreenCreating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ["DOM_PARSER"],
      justification: "Run Soulsign scheduler and sandbox bridge in MV3",
    })
    .then((value) => value)
    .catch((error) => {
      if (/Only a single offscreen document may be created/i.test(String(error))) return;
      throw error;
    })
    .finally(() => {
      offscreenCreating = null;
    });
  return offscreenCreating;
}

async function hasOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_URL);
  if ("getContexts" in chrome.runtime) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl],
    });
    return Boolean(contexts.length);
  }
  const matchedClients = await clients.matchAll();
  return matchedClients.some((client) => client.url === offscreenUrl);
}

async function forward(path, body) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ path, body, __to_offscreen__: true });
}

async function getLoopFrequencySeconds() {
  try {
    const config = await forward("config/get");
    const raw = Number(config && config.loop_freq);
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_LOOP_FREQ_SECONDS;
    return Math.max(MIN_LOOP_FREQ_SECONDS, raw);
  } catch (error) {
    console.warn("soulsign get loop frequency failed", error);
    return DEFAULT_LOOP_FREQ_SECONDS;
  }
}

async function scheduleLoopAlarm(loopFreqSeconds) {
  const delaySeconds = Math.max(MIN_LOOP_FREQ_SECONDS, Number(loopFreqSeconds) || DEFAULT_LOOP_FREQ_SECONDS);
  await chrome.alarms.create(HOURLY_ALARM_NAME, { when: Date.now() + delaySeconds * 1000 });
}

async function requestRefresh(reason) {
  const now = Date.now();
  if (now - lastWakeRefreshAt < 30000) return false;
  try {
    await forward("task/refresh", { reason });
    lastWakeRefreshAt = now;
    return true;
  } catch (error) {
    console.error("soulsign refresh failed", reason, error);
    return false;
  }
}

function waitForTabComplete(tabId, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`页面跳转超时>${timeout / 1000}s`));
    }, timeout);
    function listener(updatedTabId, info) {
      if (updatedTabId !== tabId || info.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(true);
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

const bridge = {
  async "storage.get"({ area, key }) {
    return getStorageArea(area).get(key);
  },
  async "storage.set"({ area, value }) {
    return getStorageArea(area).set(value);
  },
  async "cookies.get"(details) {
    return chrome.cookies.get(details);
  },
  async "cookies.set"(details) {
    return chrome.cookies.set(details);
  },
  async "cookies.remove"(details) {
    return chrome.cookies.remove(details);
  },
  async "tabs.create"(details) {
    const payload = Object.assign({}, details);
    if (payload.windowId == null) delete payload.windowId;
    const tab = await createTab(payload);
    return {
      id: tab.id,
      url: tab.url,
      pendingUrl: tab.pendingUrl,
      windowId: tab.windowId,
      active: tab.active,
    };
  },
  async "tabs.remove"(tabId) {
    return chrome.tabs.remove(tabId);
  },
  async "tabs.get"(tabId) {
    const tab = await getTab(tabId);
    return {
      id: tab.id,
      url: tab.url,
      pendingUrl: tab.pendingUrl,
      windowId: tab.windowId,
      active: tab.active,
    };
  },
  async "tabs.waitComplete"({ tabId, timeout }) {
    return waitForTabComplete(tabId, timeout);
  },
  async "windows.create"(details) {
    return chrome.windows.create(details);
  },
  async "windows.remove"(windowId) {
    return chrome.windows.remove(windowId);
  },
  async "webNavigation.getAllFrames"(details) {
    return chrome.webNavigation.getAllFrames(details);
  },
  async "scripting.execute"(details) {
    const payload = Object.assign({}, details);
    if (!payload.files && !payload.func) {
      payload.func = executeSoulsignEval;
    }
    return chrome.scripting.executeScript(payload);
  },
  async "notifications.create"(details) {
    if (details.url) {
      notificationTargets.set(details.id, details.url);
    }
    return chrome.notifications.create(details.id, details.options);
  },
  async "notifications.waitClick"({ id, url }) {
    if (!url) return true;
    return new Promise((resolve) => {
      function onClicked(clickedId) {
        if (clickedId !== id) return;
        chrome.notifications.onClicked.removeListener(onClicked);
        chrome.tabs.create({ url }).finally(() => resolve(true));
      }
      chrome.notifications.onClicked.addListener(onClicked);
      setTimeout(() => {
        chrome.notifications.onClicked.removeListener(onClicked);
        resolve(true);
      }, 300000);
    });
  },
  async "action.setBadge"(details) {
    if (details.text) {
      await chrome.action.setBadgeBackgroundColor({ color: details.color || "#F44336" });
      await chrome.action.setBadgeText({ text: details.text });
    } else {
      await chrome.action.setBadgeText({ text: "" });
    }
    return true;
  },
};

chrome.notifications.onClicked.addListener((notificationId) => {
  const url = notificationTargets.get(notificationId);
  if (!url) return;
  notificationTargets.delete(notificationId);
  chrome.tabs.create({ url }).catch(() => {});
});

chrome.notifications.onClosed.addListener((notificationId) => {
  notificationTargets.delete(notificationId);
});

async function init() {
  const loopFreqSeconds = await getLoopFrequencySeconds();
  await chrome.alarms.create(STARTUP_ALARM_NAME, { when: Date.now() + 60 * 1000 });
  await scheduleLoopAlarm(loopFreqSeconds);
}

chrome.runtime.onInstalled.addListener(() => {
  init().catch((error) => {
    console.error("soulsign init failed", error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  init().catch((error) => {
    console.error("soulsign init failed", error);
  });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== STARTUP_ALARM_NAME && alarm.name !== HOURLY_ALARM_NAME) return;
  try {
    await requestRefresh(alarm.name);
    if (alarm.name === HOURLY_ALARM_NAME) {
      const loopFreqSeconds = await getLoopFrequencySeconds();
      await scheduleLoopAlarm(loopFreqSeconds);
    }
  } catch (error) {
    console.error("soulsign tick failed", error);
  }
});

init().catch((error) => {
  console.error("soulsign init failed", error);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.__from_offscreen__ || message.__to_offscreen__) return false;
  if (message.__bridge__) {
    const handler = bridge[message.method];
    if (!handler) {
      sendResponse({ no: 404, msg: `unknown bridge method: ${message.method}` });
      return true;
    }
    (async () => {
      try {
        const data = await handler(message.args);
        sendResponse({ no: 200, data });
      } catch (error) {
        sendResponse({ no: 500, msg: String(error) });
      }
    })();
    return true;
  }
  (async () => {
    try {
      const data = await forward(message.path, message.body);
      if (message.path === "config/set") {
        const loopFreqSeconds = Number(data && data.loop_freq);
        await scheduleLoopAlarm(loopFreqSeconds);
      }
      sendResponse(data);
    } catch (error) {
      sendResponse({ no: 500, msg: String(error) });
    }
  })();
  return true;
});
