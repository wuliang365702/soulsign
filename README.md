# soulsign

这是 `soulsign-chrome` 的后续维护版本。

原项目地址：

- `keg1255/soulsign-chrome`：https://github.com/keg1255/soulsign-chrome

## 项目说明

原作者停止维护后，我在原项目基础上继续更新这个扩展。

原项目主要基于 `Manifest V2`，但当前 Chromium 内核浏览器已经不再支持 `Manifest V2`，因此我对项目进行了后续适配与维护，使其可以继续运行在较新的浏览器版本上。

当前仓库的重点是：

- 基于原项目继续维护
- 将扩展从 `Manifest V2` 适配到 `Manifest V3`
- 持续兼容新版本浏览器
- 当前维护版本为 `2.6.1`

另外，当前版本的部分迁移与改动使用了 AI 辅助完成代码调整。

## 目录说明

- `manifest.json`：扩展清单文件
- `popup.html`：插件弹窗页面
- `options.html`：主要管理页面
- `offscreen.html`：offscreen 页面
- `sandbox.html`：沙箱页面
- `js/`：扩展脚本
- `icons/`：扩展图标
- `static/`：静态资源
- `tools/`：校验脚本和手工回归检查文档

## 本地加载方式

1. 打开 `chrome://extensions` 或 Edge 扩展管理页面。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择当前项目目录。

## 开发说明

- 扩展版本号定义在 `manifest.json`
- `options.html` 中展示的版本号应与 `manifest.json` 保持一致
- 修改页面或脚本后，建议检查 `tools/manual-regression-checklist.md`

## 校验

可使用 Node.js 运行仓库自带的校验脚本：

```powershell
node .\tools\verify-offscreen-pure.js
node .\tools\verify-options-pure.js
node .\tools\verify-all.js
```

## 发布版本

当前标签：

```text
v2.6.1
```
