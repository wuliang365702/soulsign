# build_v2.6.1

这是一个浏览器扩展项目，当前目录已经包含可直接加载的构建产物。

## 目录说明

- `manifest.json`: 扩展清单
- `popup.html`: 弹窗页面
- `options.html`: 配置页面
- `offscreen.html`: offscreen 页面
- `sandbox.html`: 沙箱页面
- `js/`: 主要脚本
- `icons/`: 扩展图标
- `static/`: 静态资源
- `tools/`: 校验和回归检查脚本

## 本地调试

1. 打开 Chrome 或 Edge 的扩展管理页。
2. 开启“开发者模式”。
3. 选择“加载已解压的扩展程序”。
4. 指向当前目录 `build_v2.5.15`。

## GitHub 维护建议

建议把这个目录作为一个独立仓库维护，而不是直接把整个 `MyProject` 一起上传。

首次初始化：

```powershell
cd D:\OneDrive\MyProject\_JS\build_v2.5.15
git init
git add .
git commit -m "chore: initial commit"
git branch -M main
git remote add origin https://github.com/<your-name>/<repo-name>.git
git push -u origin main
```

日常提交流程：

```powershell
git status
git add .
git commit -m "feat: describe your change"
git push
```

## 发布版本建议

- 开发分支持续迭代
- 重要节点打 tag，例如 `v2.6.1`
- 在 GitHub Releases 上传压缩包

示例：

```powershell
git tag -a v2.6.1 -m "release v2.6.1"
git push origin v2.6.1
```

## 提交前检查

- 确认 `manifest.json` 中版本号正确
- 确认 `tools/` 下的检查脚本通过
- 不要提交临时压缩包、日志和编辑器缓存文件
