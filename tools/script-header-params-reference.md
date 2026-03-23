# 脚本头参数对照表

这份文档用于说明当前 `build_v2.5.15` 里，常见脚本头参数分别会影响什么，以及它们在代码中的主要落点。

## 核心结论

日常写签到脚本时，最值得优先写好的参数是：

- `@loginURL`
- `@domain`
- `@expire`
- `@param`

因为这 4 个会直接影响：

- 站点展示
- 在线状态复查
- 通知跳转
- 执行结果里的 `domain/url`
- 参数输入与调试

## 参数说明

### `@name`

作用：

- 脚本名称

当前版用途：

- 任务唯一键的一部分
- 管理页脚本名显示
- 通知标题显示

主要代码位置：

- [`offscreen.js`](../js/offscreen.js) `parseTask()`
- [`offscreen.js`](../js/offscreen.js) `taskKey()`
- [`options.js`](../js/options.js) `renderTaskRow()`

说明：

- 当前版缺少 `@name` 会直接报错，属于必填项

### `@author`

作用：

- 脚本作者

当前版用途：

- 任务唯一键的一部分
- 管理页作者列显示

主要代码位置：

- [`offscreen.js`](../js/offscreen.js) `parseTask()`
- [`offscreen.js`](../js/offscreen.js) `taskKey()`
- [`options.js`](../js/options.js) `renderTaskRow()`

说明：

- 当前版通常按 `author/name` 识别同一个脚本

### `@version`

作用：

- 脚本版本号

当前版用途：

- 管理页版本列显示
- 自动更新时比较新旧版本

主要代码位置：

- [`offscreen.js`](../js/offscreen.js) `compareVersions()`
- [`offscreen.js`](../js/offscreen.js) `upgradeTasksIfNeeded()`
- [`options.js`](../js/options.js) `renderTaskRow()`

### `@namespace`

作用：

- 脚本来源标识

当前版用途：

- 主要作为元数据保留

说明：

- 当前版里它不是调度或执行的核心参数

### `@loginURL`

作用：

- 站点主入口或登录入口

当前版用途：

- 掉线/失败通知的跳转地址
- 执行结果详情里的 `url`
- 管理页站点链接的回退地址
- 图标和站点归属推断

主要代码位置：

- [`offscreen.js`](../js/offscreen.js) `normalizeResult()`
- [`offscreen.js`](../js/offscreen.js) `notifyTaskFailure()`
- [`offscreen.js`](../js/offscreen.js) `notifyTaskOffline()`
- [`options.js`](../js/options.js) `faviconUrl()`
- [`options.js`](../js/options.js) `resolveTaskLink()`

说明：

- 这是当前版最重要的站点入口参数之一

### `@domain`

作用：

- 脚本归属的站点域名

当前版用途：

- 管理页“站点”列展示
- 执行结果里的 `domain`
- 图标与站点归属

主要代码位置：

- [`offscreen.js`](../js/offscreen.js) `parseTask()`
- [`offscreen.js`](../js/offscreen.js) `normalizeResult()`
- [`options.js`](../js/options.js) `renderSiteCell()`
- [`options.js`](../js/options.js) `resolveTaskLink()`

说明：

- 当前版会把 `@domain` 转成 `task.domains`

### `@expire`

作用：

- 在线状态缓存多久

当前版用途：

- 决定任务多久后需要重新执行 `check()`

主要代码位置：

- [`offscreen.js`](../js/offscreen.js) `parseTask()`
- [`offscreen.js`](../js/offscreen.js) `getOnlineRecheckMs()`
- [`offscreen.js`](../js/offscreen.js) `schedulerTick()`
- [`options.js`](../js/options.js) `openScheduleDebug()`

当前规则：

- 脚本里有 `@expire`：优先使用脚本值
- 脚本里没有或值不合法：回退到全局兜底值

说明：

- 当前版这里已经重新接近原版逻辑

### `@param`

作用：

- 定义脚本运行需要的输入参数

当前版用途：

- 生成“配置参数”弹窗
- 生成“调试参数”弹窗
- 把参数传给 `check(param)` / `run(param)`

主要代码位置：

- [`offscreen.js`](../js/offscreen.js) `parseTask()`
- [`offscreen.js`](../js/offscreen.js) `task/debug`
- [`options.js`](../js/options.js) `openParams()`
- [`options.js`](../js/options.js) `openDebugParams()`
- [`options.js`](../js/options.js) `saveParams()`

示例：

```js
// @param             name 账号
// @param             pwd 密码
```

### `@updateURL`

作用：

- 脚本更新地址

当前版用途：

- 自动更新开启时，按这个地址拉取新版脚本
- 用 `@version` 判断是否升级

主要代码位置：

- [`offscreen.js`](../js/offscreen.js) `upgradeTasksIfNeeded()`

说明：

- 没有 `@updateURL` 的脚本不会参与自动更新检查

### `@grant`

作用：

- 声明脚本能力

当前版用途：

- 主要作为元数据保留

说明：

- 当前版里它不是调度或执行主链路的关键参数

## 推荐模板

```js
// ==UserScript==
// @name              站点名称
// @namespace         https://github.com/your-name/your-repo
// @version           1.0.0
// @author            你的名字
// @loginURL          https://example.com/checkin
// @expire            300e3
// @domain            example.com
// @param             name 账号
// @param             pwd 密码
// ==/UserScript==
```

## 备注

- `@name` 和 `@author` 在当前版里会共同参与任务识别
- `@expire` 影响的是“多久重新 `check` 在线状态”，不是“多久执行一次 `run`”
- `@loginURL` 写得越准确，通知跳转、详情里的 `url`、站点打开链接就越准确
