(function () {
  const MESSAGE_PATHS = {
    recordBegin: "record/begin",
    recordCode: "record/code",
  };

  const RECORD_BEGIN_PROMPT = "点击确定开始录制, 切换回魂签界面结束录制。";

  function getCookie(name) {
    const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
    return match ? decodeURIComponent(match[1]) : "";
  }

  function clearCookie(name) {
    document.cookie = `${name}=; expires=${new Date(0).toUTCString()}; path=/`;
  }

  const injected = getCookie("__soulsign_inject__");
  if (injected) {
    clearCookie("__soulsign_inject__");
    const script = document.createElement("script");
    script.setAttribute("soulsign", "");
    script.textContent = injected;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  }

  if (!getCookie("__soulsign_record__") || window.__soulsign_record__) return;
  window.__soulsign_record__ = true;

  function getSelector(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) {
      const idSelector = "#" + CSS.escape(el.id);
      if (document.querySelector(idSelector) === el) return idSelector;
    }
    const classNames = String(el.className || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    let selector = "";
    for (const className of classNames) {
      selector += "." + CSS.escape(className);
      if (document.querySelector(selector) === el) return selector;
    }
    if (!selector) {
      selector = el.tagName.toLowerCase();
      if (document.querySelector(selector) === el) return selector;
    }
    const parentSelector = getSelector(el.parentElement);
    if (!parentSelector) return selector;
    selector = parentSelector + ">" + selector;
    if (document.querySelector(selector) === el) return selector;
    const siblings = Array.from(el.parentElement ? el.parentElement.children : []);
    const index = siblings.indexOf(el);
    return index >= 0 ? `${parentSelector}>:nth-child(${index + 1})` : selector;
  }

  function sendCode(body, callback) {
    const frameUrl = location.href.split("?")[0];
    const code =
      window.top === window
        ? `await ${body}`
        : `await fb.getFrame(${JSON.stringify(frameUrl)}, 2).then(fb => ${body})`;
    chrome.runtime.sendMessage({ path: MESSAGE_PATHS.recordCode, body: code }, callback);
  }

  function recordValue(el, selector, callback) {
    if (!el) return;
    const nextValue = String(el.value || "");
    if (el.__soulsign_last_value__ === nextValue) {
      if (typeof callback === "function") callback();
      return;
    }
    el.__soulsign_last_value__ = nextValue;
    sendCode(`fb.value(${JSON.stringify(selector)}, ${JSON.stringify(nextValue)})`, callback);
  }

  function bindInput(el, selector) {
    if (!el || el.__soulsign_input__) return;
    if (!["INPUT", "TEXTAREA"].includes(el.tagName)) return;
    if (/submit|button/i.test(el.type || "")) return;
    const resolved = selector || getSelector(el);
    if (!resolved) return;
    el.__soulsign_input__ = true;
    if (el.value) {
      recordValue(el, resolved);
    }
    el.addEventListener("change", () => {
      recordValue(el, resolved);
    });
  }

  function replayPress(el, keyCode) {
    ["keydown", "keypress", "keyup"].forEach((type) => {
      const event = new KeyboardEvent(type, {
        bubbles: true,
        cancelable: true,
        keyCode,
        which: keyCode,
      });
      el.dispatchEvent(event);
    });
    if (keyCode === 13) {
      let parent = el.parentElement;
      while (parent) {
        if (parent.tagName === "FORM") {
          parent.submit();
          break;
        }
        parent = parent.parentElement;
      }
    }
  }

  document.addEventListener("keyup", (event) => {
    if (event.key === "Tab") bindInput(event.target);
  });

  document.addEventListener(
    "keypress",
    (event) => {
      if (!event.isTrusted || event.key !== "Enter") return;
      const el = event.target;
      const selector = getSelector(el);
      if (!selector) return;
      event.stopPropagation();
      event.preventDefault();
      const done = () => replayPress(el, 13);
      if (["INPUT", "TEXTAREA"].includes(el.tagName) && !/submit|button/i.test(el.type || "")) {
        recordValue(el, selector, () => sendCode(`fb.press(${JSON.stringify(selector)}, 13)`, done));
      } else {
        sendCode(`fb.press(${JSON.stringify(selector)}, 13)`, done);
      }
    },
    true
  );

  document.addEventListener(
    "click",
    (event) => {
      if (!event.isTrusted) return;
      const selector = getSelector(event.target);
      if (!selector) return;
      event.stopPropagation();
      event.preventDefault();
      sendCode(`fb.click(${JSON.stringify(selector)})`, () => event.target.click());
      bindInput(event.target, selector);
    },
    true
  );

  if (document.activeElement) bindInput(document.activeElement);

  if (window.top === window && !window.__soulsign_record_main__) {
    window.__soulsign_record_main__ = true;
    chrome.runtime.sendMessage(
      {
        path: MESSAGE_PATHS.recordBegin,
        body: { title: document.title || "", url: location.href || "" },
      },
      (resp) => {
        if (chrome.runtime.lastError) return;
        if (resp && resp.no === 200 && resp.data && resp.data.showPrompt) {
          alert(RECORD_BEGIN_PROMPT);
        }
      }
    );
    return;
  }

  
})();
