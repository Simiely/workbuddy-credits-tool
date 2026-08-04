@echo off
rem WorkBuddy credits dashboard launcher (desktop scheme: Edge CDP)
rem Usage: double-click this file. Close the window to stop the server.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found in PATH. Please install Node.js 22 or later first.
    pause
    exit /b 1
)

echo Starting WorkBuddy credits dashboard...
echo   URL:       http://127.0.0.1:8080
echo   Collector: edge (Edge CDP) - keep Edge logged in
echo   Data:      wb-*.json / credits.db in this folder
echo.
echo Close this window to stop the server.
echo.
node wb-gui.mjs
echo.
echo Server exited with code %errorlevel%
pause
