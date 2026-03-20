# 手工回归检查清单

## 核心界面

1. 在 `chrome://extensions` 里重新加载扩展。
2. 打开 `options.html`，确认任务列表能正常显示。
3. 至少等待一轮自动刷新，确认列表不会明显闪烁或错乱。

## 录制流程

1. 点击 `录制脚本`。
2. 确认录制弹窗打开后只显示网址输入框。
3. 输入签到网址并点击 `确定`。
4. 在目标页面确认提示只出现一次：
   `点击确定开始录制, 切换回魂签界面结束录制。`
5. 完成签到操作后，切回魂签任务管理页。
6. 确认录制生成的脚本编辑器会自动打开。
7. 确认生成的脚本包含：
   - `@author            魂签录制`
   - `@loginURL`
   - `@domain`
   - `@param             name 账号`
   - `@param             pwd 密码`

## 脚本操作

1. 打开一个已有脚本，点击 `调试CHECK`。
2. 打开一个已有脚本，点击 `调试RUN`。
3. 保存脚本后，确认任务列表刷新正常。

## 任务操作

1. 测试任务启用和禁用开关。
2. 从任务列表里手动执行一个任务。
3. 删除一个任务。
4. 点击 `清空计数`，确认统计被清空。

## 导入 / 导出

1. 点击 `导出脚本` 导出当前脚本。
2. 使用 `导入脚本` 重新导入之前导出的文件。
3. 确认导入后的任务仍能正常显示和编辑。

## 验证命令

每次代码改动后，可以运行下面这些命令做基础验证：

```powershell
node D:\OneDrive\MyProject\_JS\build_v2.5.15\tools\verify-offscreen-pure.js
node D:\OneDrive\MyProject\_JS\build_v2.5.15\tools\verify-options-pure.js
node D:\OneDrive\MyProject\_JS\build_v2.5.15\tools\verify-all.js
```
