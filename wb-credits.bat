@echo off
rem ============================================================
rem  wb-credits.bat - WorkBuddy credits CLI (multi-account)
rem  Usage:
rem    wb-credits save-current [name]  save current Edge account into pool
rem    wb-credits accounts             list account pool
rem    wb-credits del <id|no|uin>      delete an account
rem    wb-credits all                  query ALL accounts (one-click)
rem    wb-credits all --csv out.csv    query all + export csv
rem    wb-credits [--account <id|no>]  query single account (default: first)
rem    wb-credits --all | --json | --csv out.csv   single-account options
rem  Note: save-current needs Edge running with workbuddy.cn logged in.
rem  Node resolution: try PATH first, fall back to WorkBuddy managed Node.
rem ============================================================
chcp 65001 >nul
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

"%NODE_CMD%" "%~dp0wb-credits.mjs" %*
echo.
pause
