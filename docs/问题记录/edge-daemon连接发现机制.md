# edge-daemon 连接发现机制(DevToolsActivePort 残留文件坑)

> **TL;DR**:daemon 读 `Edge User Data/DevToolsActivePort` 文件发现调试端点,但该文件可能残留旧实例 uuid → 拿着失效 ws 路径连接一个不存在的 WebSocket,**永久挂起**。修复(v1.0.3):改用标准 CDP 发现——轮询 `GET :9222/json/version` 拿真实 `webSocketDebuggerUrl`。

## 问题

- 现象:edge-daemon 一直 `connected:false`,日志停在 `connecting ws://.../devtools/browser/<旧uuid>` 后**连超时都不触发**(连接目标不存在)。
- 用户已允许 Edge 调试授权、重启浏览器仍无效——因为连接目标本身就是错的。

## 根因

`DevToolsActivePort` 文件是**早上某次调试实例启动时写的**(含端口 + browser target uuid),Edge 新实例启动后**不总是重写它**(可能复用以存在文件)。daemon 每次读该文件 → 拿到过期 uuid → 连接失败。

**浏览器状态文件不可靠;浏览器自身的 HTTP 端点才是权威。**

## 解决(v1.0.3)

- 弃用读文件,改为:轮询 `GET http://127.0.0.1:<debugPort>/json/version` → 取 `webSocketDebuggerUrl` → 连接(3s 重试)
- 端口规范:daemon HTTP API = **8129**(平台端口段内,可被 tools-center 托管);Edge 调试 = **9222**(默认,`EDGE_DEBUG_PORT` 或 argv[3] 可覆盖)
- 全部 daemon 端口 9333 → 8129(`lib/util.js` / `lib/daemon.js` / `edge-daemon.mjs` / `edge-ctl.mjs`)

## 补充:Edge 调试端口打不开(2026-08-03 新坑)

即使改用标准 CDP 发现,`--remote-debugging-port=9222` 也可能不生效:

1. **Startup Boost 抢跑**:Edge 关闭后后台进程仍在,新命令只打开新标签页,flag 被忽略。
2. **默认目录被拒绝**:Edge 要求 `--user-data-dir` 指向非默认路径才能启用远程调试。

正确启动方式:
```bash
taskkill /F /IM msedge.exe
cp -r "%LOCALAPPDATA%/Microsoft/Edge/User Data" /tmp/edge-debug
msedge --remote-debugging-port=9222 --user-data-dir="/tmp/edge-debug" https://www.workbuddy.cn/profile/plans-usage
```

## 预防

- 任何"读浏览器/进程状态文件"的逻辑都不可靠,优先用服务自身 HTTP 发现端点
- **改 `lib/util.js` 常量后必须重启常驻子进程**(模块加载时读值,改文件不生效)——本轮 wb-gui 子进程因此短暂探测旧端口
- Edge 调试端口不是开了就一劳永逸——**首次配好保留启动脚本**,勿每次手敲。
