# AGENTS.md · 项目规则

> 给 AI 与"未来的你"看的精简规则。核心约束尽量短,细节放 `rules/` 按需 @引用。
>
> **接手先读**:[`docs/交接说明.md`](docs/交接说明.md)(运行实例/端口/三处同步/数据文件/待办的状态快照)。

## 技术栈

- Node.js ≥ 18(开发用 22.x),**纯原生 ESM**,零第三方依赖(`node:http` / `node:fs` / fetch / AbortController)
- 浏览器侧:Edge CDP(WebSocket)→ `edge-daemon.mjs` 独立进程提供本地 HTTP API(仅添加账号用)
- GUI 前端:原生 HTML/CSS/JS,无框架;折线图为自绘 SVG
- 当前版本:v1.0.12(见 CHANGELOG)

## 关键坑(摘要,详情见 @rules/常见坑.md)

1. GUI 的 `wb-gui.html/js` **每次请求实时读文件** → 改前端刷新页面即可,无需重启;改 `wb-gui.mjs`/`lib/*` 才需重启
2. 前端响应已加 `Cache-Control: no-store` + 全接口 CORS——别删,浏览器缓存/跨域都踩过坑
3. **所有"总量/剩余"口径 = 体验版基础用量 + 赠送积分**,前端/后端/历史快照/仪表盘必须一致
4. 刷新必须有超时兜底(服务端单账号 8s、前端 12s),按钮状态单点控制,否则会"无限转圈"
5. 历史快照**同分钟去重**(`lib/history.js`),快照读取后必须按时间升序排序(折线方向)
6. **子路径挂载自适应**:资源用相对路径,API 全部 `__BASE__ + "/api/.."`(`__BASE__` 平台注入或自行检测;独立运行为空)——否则挂载到 `/tool/<id>/` 后按钮全失效
7. edge-daemon 端口 **8129**(HTTP API)/ Edge 调试 **9222**;发现机制用 CDP 标准(`/json/version`),**勿改回读 DevToolsActivePort 文件**(残留坑);改 `lib/util.js` 后必须重启常驻子进程

## 约定

- 业务逻辑一律进 `lib/`(CLI 与 GUI 自动同步生效);CLI/GUI 入口只做分发
- 注释、UI、文档全部中文;文件命名英文,文档中文
- 凭证文件(`wb-accounts.json` / `wb-sync.json`)与运行数据(`wb-history.json` / `wb-last-data.json` / `*.log`)严禁上传,已 gitignore

## 常用命令

```bash
# 语法校验(改动后必跑)
node --check wb-credits.mjs && node --check wb-gui.mjs && node --check wb-gui.js

# CLI
node wb-credits.mjs accounts          # 账号池
node wb-credits.mjs all               # 批量查询
node wb-credits.mjs save-current      # 添加当前 Edge 登录的账号

# GUI(启动/重启:先杀 8080 进程再启)
node wb-gui.mjs

# 回归验证
curl http://127.0.0.1:8080/api/all
```

## 详细规则(按需 @引用)

- @rules/技术栈.md  @rules/常见坑.md
