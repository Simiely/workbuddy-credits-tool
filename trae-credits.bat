@echo off
rem ============================================================
rem  trae-credits.bat - TRAE/WorkBuddy 多账号积分 CLI
rem  用法:
rem    trae-credits scan                      扫描本机登录态建立账号池
rem    trae-credits accounts                  查看账号池
rem    trae-credits all                       一键批量查询全部账号
rem    trae-credits all --csv out.csv         查询全部并导出 CSV
rem    trae-credits rename <序号|id|Uin> <名>  设置显示名
rem    trae-credits del <序号|id|Uin>          删除账号
rem    trae-credits [--account <序号|id|Uin>]  查询单个账号
rem  Node 解析: 优先 PATH;否则回退 WorkBuddy 受管 Node(需 >=22.5,内置 node:sqlite)。
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
        pause
        exit /b 1
    )
)

"%NODE_CMD%" "%~dp0trae-credits.mjs" %*
echo.
pause
