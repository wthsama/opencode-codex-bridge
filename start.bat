@echo off
chcp 65001 >nul
cd /d "%~dp0"
title OpenCode Codex Bridge

:: 1. 检查 Node.js 环境
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js (推荐 v18 及以上版本): https://nodejs.org/
    echo.
    pause
    exit /b 1
)

:: 2. 检查依赖是否存在，如不存在则自动安装
if not exist "node_modules\" (
    echo [提示] 检测到首次运行，正在自动安装所需依赖，请稍候...
    call npm install
    if %errorlevel% neq 0 (
        echo [错误] 依赖安装失败，请检查网络后重试。
        echo.
        pause
        exit /b 1
    )
    echo [完成] 依赖安装成功！
    echo.
)

:: 3. 启动后台定时延迟打开浏览器，确保 Node 服务监听就绪
start /b "" cmd /c "timeout /t 1 /nobreak >nul & start http://127.0.0.1:15722"

:: 4. 运行服务
echo [启动] 正在启动 OpenCode Codex Bridge 服务...
node src\index.js
if %errorlevel% neq 0 (
    echo.
    echo [提示] 服务已停止。
)
pause

