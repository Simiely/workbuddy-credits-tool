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
rem ============================================================
chcp 65001 >nul
"C:\Users\2504\.workbuddy\binaries\node\versions\22.22.2\node.exe" "D:\workbuddy\2026-08-03-09-29-43\tools\wb-credits.mjs" %*
echo.
pause
