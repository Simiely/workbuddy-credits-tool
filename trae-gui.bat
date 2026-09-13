@echo off
rem ============================================================
rem  trae-gui.bat - TRAE/WorkBuddy 积分仪表盘启动器(桌面一键启动)
rem  用法: 双击本文件即启动服务;关闭本窗口即停止。
rem  数据(credits.db 等)落在此 bat 同目录。
rem  Node 解析: 优先 PATH;否则回退 WorkBuddy 受管 Node(内置 node:sqlite,需 >=22.5)。
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"

set "NODE_CMD=node"
where node >nul 2>nul
if errorlevel 1 (
    if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2\node.exe" (
        set "NODE_CMD=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2\node.exe"
    ) else (
        echo [ERROR] 未找到 Node.js。请先安装 Node.js 22 或更高版本(需内置 node:sqlite)。
        echo 下载: https://nodejs.org/
        pause
        exit /b 1
    )
)

echo 正在启动 TRAE/WorkBuddy 积分仪表盘...
echo   地址:   http://127.0.0.1:8080
echo   数据:   credits.db / trae-*.json(本目录)
echo 关闭此窗口即停止服务。
echo.
"%NODE_CMD%" trae-gui.mjs
echo.
echo 服务已退出, 退出码 %errorlevel%
pause
