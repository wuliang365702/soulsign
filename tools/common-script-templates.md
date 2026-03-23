# 常见签到脚本模板

这份文档整理了当前项目里最常见的几类脚本写法，方便后续新增站点时直接选一个最接近的模板开始改。

## 先选哪种模板

可以先按站点特征判断：

### 1. 纯在线检测型

适合：

- 不需要真正签到
- 只需要确认是否在线/是否登录
- 例如某些站点只要求保持登录态

### 2. 自动登录 + 签到型

适合：

- 站点需要账号密码登录
- 登录后才能签到
- 没有复杂验证码或风控

### 3. 复用 cookie / 手工登录型

适合：

- 登录经常触发滑块验证码
- 不适合脚本自动登录
- 更适合手工登录一次后复用现有登录态

## 模板 1：纯在线检测型

适合：

- 只判断当前账号是否在线
- `run()` 不做复杂动作

```js
// ==UserScript==
// @name              站点名称
// @version           1.0.0
// @author            你的名字
// @loginURL          https://example.com/
// @expire            300e3
// @domain            example.com
// ==/UserScript==

const PAGE_URL = "https://example.com/";

async function readUserState(fb) {
  return await fb.eval(() => {
    const text = document.body ? document.body.innerText : "";
    return {
      loggedIn: /退出|设置|消息|提醒/.test(text),
      text,
    };
  });
}

exports.check = async function (param) {
  return await open(PAGE_URL, false, async (fb) => {
    await fb.sleep(2500);
    const state = await readUserState(fb);
    return state.loggedIn;
  });
};

exports.run = async function (param) {
  return await open(PAGE_URL, false, async (fb) => {
    await fb.sleep(2500);
    const state = await readUserState(fb);
    if (!state.loggedIn) throw "未登录";
    return "在线";
  });
};
```

## 模板 2：自动登录 + 签到型

适合：

- `check()` 负责在线检测和补登录
- `run()` 只负责签到

```js
// ==UserScript==
// @name              站点名称
// @version           1.0.0
// @author            你的名字
// @loginURL          https://example.com/checkin
// @expire            300e3
// @domain            example.com
// @param             name 账号
// @param             pwd 密码
// ==/UserScript==

const PAGE_URL = "https://example.com/checkin";
const LOGIN_URL = "https://example.com/login";
const CHECKIN_SELECTOR = ".signbtn a.btna";

async function readUserState(fb) {
  return await fb.eval((selector) => {
    const text = document.body ? document.body.innerText : "";
    const btn = document.querySelector(selector);
    const btnText = btn ? btn.innerText.trim() : "";

    return {
      loggedIn: /退出|设置|消息|提醒/.test(text),
      checkedIn: /今日已打卡|已签到|签过了/.test(btnText),
      hasCheckinBtn: !!btn,
      btnText,
      text,
    };
  }, CHECKIN_SELECTOR);
}

async function doLogin(param) {
  if (!(param.name && param.pwd)) return false;

  await open(LOGIN_URL, false, async (fb) => {
    await fb.sleep(2500);
    await fb.value("#username", param.name);
    await fb.value("#password", param.pwd);
    await fb.click("[name='loginsubmit']");
    await fb.sleep(3000);
  });

  return await open(PAGE_URL, false, async (fb) => {
    await fb.sleep(2500);
    const state = await readUserState(fb);
    return state.loggedIn;
  });
}

exports.check = async function (param) {
  const online = await open(PAGE_URL, false, async (fb) => {
    await fb.sleep(2500);
    const state = await readUserState(fb);
    return state.loggedIn;
  });

  if (online) return true;
  return await doLogin(param);
};

exports.run = async function (param) {
  return await open(PAGE_URL, false, async (fb) => {
    await fb.sleep(2500);
    const state = await readUserState(fb);

    if (!state.loggedIn) throw "未登录，请先执行CHECK";
    if (state.checkedIn) return "签过了";
    if (!state.hasCheckinBtn) throw "未找到签到按钮";

    await fb.click(CHECKIN_SELECTOR);
    await fb.waitLoaded();
    await fb.sleep(3000);

    const nextState = await readUserState(fb);
    if (nextState.checkedIn) return "签到成功";
    throw `需重试，当前按钮文字：${nextState.btnText || "未知"}`;
  });
};
```

## 模板 3：复用 cookie / 手工登录型

适合：

- 登录页有滑块验证码
- 不适合脚本自动补登录
- 依赖你先手工登录，再让脚本复用登录态

```js
// ==UserScript==
// @name              站点名称
// @version           1.0.0
// @author            你的名字
// @loginURL          https://example.com/checkin
// @expire            300e3
// @domain            example.com
// ==/UserScript==

const PAGE_URL = "https://example.com/checkin";
const CHECKIN_SELECTOR = ".signbtn a.btna";

async function readUserState(fb) {
  return await fb.eval((selector) => {
    const text = document.body ? document.body.innerText : "";
    const btn = document.querySelector(selector);
    const btnText = btn ? btn.innerText.trim() : "";

    return {
      loggedIn: /退出|设置|消息|提醒/.test(text),
      checkedIn: /今日已打卡|已签到|签过了/.test(btnText),
      hasCheckinBtn: !!btn,
      btnText,
      text,
    };
  }, CHECKIN_SELECTOR);
}

exports.check = async function (param) {
  return await open(PAGE_URL, false, async (fb) => {
    await fb.sleep(2500);
    const state = await readUserState(fb);
    return state.loggedIn;
  });
};

exports.run = async function (param) {
  return await open(PAGE_URL, false, async (fb) => {
    await fb.sleep(2500);
    const state = await readUserState(fb);

    if (!state.loggedIn) throw "未登录，请先手工登录并完成验证";
    if (state.checkedIn) return "签过了";
    if (!state.hasCheckinBtn) throw "未找到签到按钮";

    await fb.click(CHECKIN_SELECTOR);
    await fb.waitLoaded();
    await fb.sleep(3000);

    const nextState = await readUserState(fb);
    if (nextState.checkedIn) return "签到成功";
    throw `需重试，当前按钮文字：${nextState.btnText || "未知"}`;
  });
};
```

## 什么时候优先看按钮文字

如果页面像论坛/门户一样干扰信息很多，优先不要用整页文本判断是否已签到，而应优先看：

- 签到按钮文字
- 个人状态区
- 某个特定小模块的文本

例如：

```js
const btn = document.querySelector(".signbtn a.btna");
const btnText = btn ? btn.innerText.trim() : "";
const checkedIn = /今日已打卡/.test(btnText);
```

这种通常比：

```js
/今日已打卡/.test(document.body.innerText)
```

更稳。

## 什么时候不要自动登录

有这些情况时，建议不要在 `check()` 里强行自动登录：

- 登录时经常弹滑块验证码
- 登录时要求短信/邮箱验证
- 登录页风控很严，自动操作容易触发封禁

这时更推荐：

- 手工登录一次
- 让脚本复用现有 cookie
- 只在掉线时提醒“需要手工登录”

## 调试建议

写新站点时，优先这样调：

1. 浏览器 F12
2. 先确认：
   - 登录成功后页面有哪些稳定关键词
   - 签到按钮的稳定选择器是什么
   - 已签到后按钮文字是否变化
3. 再回到脚本里改：
   - `loggedIn`
   - `checkedIn`
   - `CHECKIN_SELECTOR`

## 一句话总结

最推荐的默认模板是：

- `check()` 负责在线和补登录
- `run()` 负责签到

但如果网站登录有验证码，就改用：

- `check()` 只判断在线
- `run()` 只签到
- 登录依赖手工完成
