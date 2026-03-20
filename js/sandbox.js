(function () {
  let sequence = 1;
  const pending = new Map();

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function callParent(method, ...args) {
    return new Promise((resolve, reject) => {
      const id = "parent_" + sequence++;
      pending.set(id, { resolve, reject });
      parent.postMessage(
        {
          __soulsign__: true,
          id,
          type: "sandbox-call",
          payload: { method, args },
        },
        "*"
      );
    });
  }

  function frameProxy(handle, url) {
    return {
      url,
      eval(code, ...args) {
        if (typeof code === "function") {
          code = `(${code})(${args.map((arg) => JSON.stringify(arg)).join(",")})`;
        }
        return callParent("frame.eval", handle, code);
      },
      inject(code, ...args) {
        if (typeof code === "function") {
          code = `(${code})(${args.map((arg) => JSON.stringify(arg)).join(",")})`;
        }
        const wrapped = `(() => {
          const script = document.createElement("script");
          script.setAttribute("soulsign", "");
          script.textContent = ${JSON.stringify(code)};
          (document.documentElement || document.head).appendChild(script);
          script.remove();
          return true;
        })()`;
        return callParent("frame.eval", handle, wrapped);
      },
      async waitLoaded(timeout) {
        return callParent("frame.waitLoaded", handle, timeout || 10000);
      },
      async waitUntil(selector, timeout) {
        const tries = Math.ceil((timeout || 10000) / 1000);
        for (let i = 0; i < tries; i++) {
          const ok =
            typeof selector === "function"
              ? await selector().catch(() => false)
              : await this.eval((s) => !!document.querySelector(s), selector).catch(() => false);
          if (ok) return ok;
          await sleep(1000);
        }
        throw new Error("wait timeout");
      },
      async click(selector, timeout) {
        await this.waitUntil(selector, timeout);
        return this.eval((s) => {
          const el = document.querySelector(s);
          if (!el) return false;
          el.click();
          return true;
        }, selector);
      },
      async emit(selector, type, timeout) {
        await this.waitUntil(selector, timeout);
        return this.eval((s, t) => {
          const el = document.querySelector(s);
          if (!el) return false;
          el.dispatchEvent(new Event(t, { bubbles: true }));
          return true;
        }, selector, type);
      },
      async value(selector, value, timeout) {
        await this.waitUntil(selector, timeout);
        return this.eval((s, v) => {
          const el = document.querySelector(s);
          if (!el) return false;
          el.value = v;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        }, selector, value);
      },
      async press(selector, value, timeout) {
        const keyCode = typeof value === "number" ? value : value.keyCode;
        await this.waitUntil(selector, timeout);
        return this.eval((s, code) => {
          const el = document.querySelector(s);
          if (!el) return false;
          ["keydown", "keypress", "keyup"].forEach((type) => {
            const event = new KeyboardEvent(type, { bubbles: true, keyCode: code, which: code });
            el.dispatchEvent(event);
          });
          if (code === 13) {
            let parent = el.parentElement;
            while (parent) {
              if (parent.tagName === "FORM") {
                parent.submit();
                break;
              }
              parent = parent.parentElement;
            }
          }
          return true;
        }, selector, keyCode);
      },
      async iframes() {
        const frames = await callParent("frame.iframes", handle);
        return frames.map((frame) => frameProxy(frame.handle, frame.url));
      },
      async getFrame(targetUrl, fuzzy, timeout) {
        const frame = await callParent("frame.getFrame", handle, targetUrl, fuzzy || 0, timeout || 10000);
        return frameProxy(frame.handle, frame.url);
      },
      sleep,
    };
  }

  function createAxios(task) {
    const domains = task.domains || [];

    function checkDomain(url) {
      try {
        const target = new URL(url, location.href).hostname.split(".");
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

    async function request(config) {
      const url = config.url;
      if (!checkDomain(url)) throw new Error("domain mismatch");
      return callParent("fetch", {
        url,
        method: config.method || "GET",
        headers: config.headers || {},
        body: config.data,
        credentials: "include",
      });
    }

    return {
      request,
      get(url, config) {
        return request(Object.assign({}, config, { method: "GET", url }));
      },
      post(url, data, config) {
        return request(Object.assign({}, config, { method: "POST", url, data }));
      },
    };
  }

  function extTask(version) {
    return {
      version(required, current) {
        current = current || version;
        if (current === required) return 0;
        return current > required ? 1 : -1;
      },
      sleep,
    };
  }

  function createTaskModule(task) {
    const grant = new Set(task.grants || []);
    const inject = {
      axios: createAxios(task),
      tools: extTask(task.version || "0.0.0"),
      require(url) {
        if (!grant.has("require") && !grant.has("loadjs")) {
          return Promise.reject("missing grant loadjs");
        }
        return callParent("fetch", { url, method: "GET", credentials: "include" }).then(({ data }) => {
          const module = { exports: {} };
          const mod = new Function("exports", "module", data).call(module.exports, module.exports, module);
          if (mod) module.exports = mod;
          return module.exports;
        });
      },
      loadjs(url) {
        return inject.require(url);
      },
      getCookie(url, name) {
        if (!grant.has("cookie")) return Promise.reject("missing grant cookie");
        return callParent("getCookie", url, name);
      },
      setCookie(url, name, value) {
        if (!grant.has("cookie")) return Promise.reject("missing grant cookie");
        return callParent("setCookie", url, name, value);
      },
      $(html) {
        const div = document.createElement("div");
        div.innerHTML = html;
        return div.childNodes.length > 1 ? Array.from(div.childNodes) : div.childNodes[0];
      },
      notify(body, url, timeout) {
        if (!grant.has("notify")) throw new Error("missing grant notify");
        return callParent("notify", task.name, body, url, timeout || 300000);
      },
      async openWindow(url, dev, fn, preload) {
        const opened = await callParent("open", {
          url,
          active: !!dev,
          preload: typeof preload === "function" ? `(${preload})();` : preload,
          domains: task.domains || [],
          windowMode: true,
          timeout: task._timeout || 10000,
        });
        const fb = frameProxy(opened.handle, opened.url);
        try {
          return await fn(fb);
        } finally {
          await callParent("closeHandle", opened.handle);
        }
      },
      async openTab(url, dev, fn, preload) {
        const opened = await callParent("open", {
          url,
          active: !!dev,
          preload: typeof preload === "function" ? `(${preload})();` : preload,
          domains: task.domains || [],
          windowMode: false,
          timeout: task._timeout || 10000,
        });
        const fb = frameProxy(opened.handle, opened.url);
        try {
          return await fn(fb);
        } finally {
          await callParent("closeHandle", opened.handle);
        }
      },
      open(url, dev, fn, preload) {
        return inject.openTab(url, dev, fn, preload);
      },
    };

    if (!grant.has("eval")) {
      Object.assign(inject, {
        window: undefined,
        document: undefined,
        Notification: undefined,
        location: undefined,
        eval: undefined,
        Function: undefined,
        chrome: undefined,
        globalThis: undefined,
      });
    }

    const module = { exports: {} };
    new Function("exports", "module", ...Object.keys(inject), task.code)(
      module.exports,
      module,
      ...Object.values(inject)
    );
    return module;
  }

  async function runTask(task) {
    const module = createTaskModule(task);
    if (typeof module.exports.run !== "function") {
      throw new Error("script missing run()");
    }
    return module.exports.run(task._params || {});
  }

  async function checkTask(task) {
    const module = createTaskModule(task);
    if (typeof module.exports.check !== "function") {
      return true;
    }
    return !!(await module.exports.check(task._params || {}));
  }

  window.addEventListener("message", async (event) => {
    const data = event.data;
    if (!data || !data.__soulsign__) return;
    if (data.replyTo && pending.has(data.replyTo)) {
      const item = pending.get(data.replyTo);
      pending.delete(data.replyTo);
      data.ok ? item.resolve(data.payload) : item.reject(data.error);
      return;
    }
    if (data.type === "compile") {
      event.source.postMessage(
        { __soulsign__: true, replyTo: data.id, ok: true, payload: { compiled: true } },
        "*"
      );
      return;
    }
    if (data.type === "run") {
      try {
        const result = await runTask(data.payload.task);
        event.source.postMessage(
          { __soulsign__: true, replyTo: data.id, ok: true, payload: result },
          "*"
        );
      } catch (error) {
        event.source.postMessage(
          { __soulsign__: true, replyTo: data.id, ok: false, error: String(error) },
          "*"
        );
      }
      return;
    }
    if (data.type === "check") {
      try {
        const result = await checkTask(data.payload.task);
        event.source.postMessage(
          { __soulsign__: true, replyTo: data.id, ok: true, payload: result },
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

  parent.postMessage({ __soulsign__: true, type: "sandbox-ready" }, "*");
})();
