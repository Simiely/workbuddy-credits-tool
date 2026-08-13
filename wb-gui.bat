@echo off
rem WorkBuddy credits dashboard launcher (desktop scheme: Edge CDP)
rem Usage: double-click this file. Close the window to stop the server.
rem Node resolution: try PATH first, fall back to WorkBuddy managed Node.
cd /d "%~dp0"

set "NODE_CMD=node"
where node >nul 2>nul
if errorlevel 1 (
    if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2\node.exe" (
        set "NODE_CMD=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2\node.exe"
    ) else (
        echo [ERROR] Node.js not found in PATH. Please install Node.js 22 or later first.
        pause
        exit /b 1
    )
)

echo Starting WorkBuddy credits dashboard...
echo   URL:       http://127.0.0.1:8080
echo   Collector: edge (Edge CDP) - keep Edge logged in
echo   Data:      wb-*.json / credits.db in this folder
echo.
echo Close this window to stop the server.
echo.
"%NODE_CMD%" wb-gui.mjs
echo.
echo Server exited with code %errorlevel%
pause
