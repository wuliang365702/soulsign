@echo off
setlocal

cd /d "%~dp0"

git rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 (
  echo [ERROR] 当前目录不是 Git 仓库。
  pause
  exit /b 1
)

set "COMMIT_MSG=%~1"
set "TAG_NAME=%~2"

if "%COMMIT_MSG%"=="" (
  set "COMMIT_MSG=chore: update project"
)

echo.
echo [1/4] 检查仓库状态...
git status --short --branch

echo.
echo [2/4] 添加改动...
git add .
if errorlevel 1 (
  echo [ERROR] git add 失败。
  pause
  exit /b 1
)

git diff --cached --quiet
if not errorlevel 1 (
  goto do_commit
)

echo [INFO] 没有可提交的改动。
goto maybe_tag

:do_commit
echo.
echo [3/4] 提交改动...
git commit -m "%COMMIT_MSG%"
if errorlevel 1 (
  echo [ERROR] git commit 失败。
  pause
  exit /b 1
)

echo.
echo [4/4] 推送到远程...
git push
if errorlevel 1 (
  echo [ERROR] git push 失败。
  pause
  exit /b 1
)

:maybe_tag
if "%TAG_NAME%"=="" (
  echo.
  echo [DONE] 已完成提交和推送。
  pause
  exit /b 0
)

echo.
echo [TAG] 创建标签 %TAG_NAME% ...
git tag -a "%TAG_NAME%" -m "release %TAG_NAME%"
if errorlevel 1 (
  echo [ERROR] 创建标签失败，可能标签已存在。
  pause
  exit /b 1
)

echo [TAG] 推送标签 %TAG_NAME% ...
git push origin "%TAG_NAME%"
if errorlevel 1 (
  echo [ERROR] 推送标签失败。
  pause
  exit /b 1
)

echo.
echo [DONE] 已完成提交、推送和标签发布。
pause
exit /b 0
