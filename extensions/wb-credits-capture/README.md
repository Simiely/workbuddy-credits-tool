# 积分账号抓取器(wb-credits-capture)

配套 **WorkBuddy 积分仪表盘(wb-credits-tool)** 的浏览器扩展:在**日常浏览器**里抓取当前登录的 workbuddy.cn 账号 Cookie,同步到 WebDAV,供仪表盘「一键同步」导入。

**目的**:替代「调试 Edge 副本 + 独立 profile + CDP」方案——不再需要关日常浏览器、不再有 9222 端口冲突,流程和普通软件一致(日常浏览器登录 → 点扩展 → 工具同步)。

## 安装(Edge 加载解压的扩展)

1. Edge 打开 `edge://extensions`
2. 打开右上角「开发人员模式」
3. 点「加载解压缩的扩展」→ 选择本目录(`wb-credits-capture`)
4. 工具栏出现 📉 图标即安装成功

## 使用流程

1. 在日常 Edge 登录 workbuddy.cn(任意账号)
2. 点扩展图标 → 首次填写 WebDAV 配置(留空 = `http://192.168.2.1:6086`,用户名/密码同工具 wb-sync.json)→「保存」
3. 点 **「抓取并同步 WebDAV」** —— 读当前账号 Cookie → 验证积分接口 → 合并进远端账号池 → 上传
4. 换账号:退出登录 → 登录下一个 → 再点一次「抓取并同步」,自动追加/更新
5. 全部完成后,在积分仪表盘点 **「☁️ 云同步 → 🔄 一键同步」** → 账号池即更新(工具自动导入 SQLite)

## 数据流

```
日常 Edge 登录 workbuddy.cn
  → 扩展:chrome.cookies 读登录 Cookie(含 HttpOnly)
  → 扩展:请求 billing 接口验证 + 拿账号标识(Uin)
  → 扩展:按 Uin 合并到远端 wb-accounts.json(其余账号保留)
  → 工具「一键同步」:从 WebDAV 拉取 → 导入 SQLite
```

远端路径(与工具 BACKUP_DIR 完全一致):`{webdav}/workbuddy/workbuddy积分/wb-accounts.json`

## 为什么这样做(背景)

- Edge 136+ 官方安全策略:**`--remote-debugging-port` 不再对默认浏览器生效**,必须配独立 `--user-data-dir`(开发者博客 remote-debugging-port)——所以「用日常浏览器开调试端口」这条路官方已封死
- 浏览器扩展的 `chrome.cookies` API 官方支持读取 HttpOnly Cookie(需 `cookies` 权限 + 域名 host_permissions)——扩展方案是官方认可的替代路径
- 查询积分本身不依赖浏览器(工具直连 billing 接口),唯一需要浏览器的是「登录态 → Cookie」这一环,扩展正好补位

## 安全说明

- 扩展只在点击「抓取/同步」时读取 workbuddy.cn Cookie,仅上传到你配置的 WebDAV
- WebDAV 密码明文存于 `chrome.storage.local`(与工具 wb-sync.json 同级),请勿将扩展配置页截图外发
- Cookie 有官方有效期,到期后重复「登录 → 抓取并同步」即可续期,无需调试浏览器

## 文件

| 文件 | 说明 |
|---|---|
| `manifest.json` | MV3 声明(cookies/storage 权限 + workbuddy.cn 等 host_permissions) |
| `background.js` | 核心:抓取 Cookie → billing 验证 → WebDAV 拉取/合并/上传 |
| `popup.html` / `popup.js` | 弹窗界面:抓取、同步、WebDAV 配置、测试 |
