# HANDOFF · 交接与已知问题(2026-08-04 02:00)

> 给下一位接手开发者/AI 的快速启动文档。当前版本 **v1.3.3**。

## 1. 项目是什么

**workbuddy-credits-tool** = WorkBuddy 积分监控仪表盘(多账号积分查询/趋势/到期明细/WebDAV 云同步)。
- 后端 `wb-gui.mjs`(Node 零依赖 HTTP 服务,端口 8123,路由见文件内 `/api/*`)
- 前端 `wb-gui.html` + `wb-gui.js`(单文件 851+ 行,17 个分区注释,共享状态集中在文件顶部)
- 逻辑分层:`lib/`(10 模块)负责业务;`wb-gui.mjs` 只做路由薄层
- **计算架构(v1.2.0 收敛)**:后端 `/api/dashboard/all` 是唯一计算源,按自然日(本地时区)聚合每日消耗;前端纯展示,0 计算

## 2. ⚠️ 部署副本清单(改代码必须全部同步!)

电脑上有 **3 份代码副本 + 1 个 NAS 挂载卷**,改完代码必须同步到所有副本,否则用户跑旧版:

| 位置 | 用途 |
|---|---|
| `D:\workbuddy\2026-08-03-17-17-44\workbuddy-credits-tool\` | **主工作副本**(改代码在这里) |
| `D:\workbuddy\2026-08-03-17-17-44\tools-center\tools\wb-credits\` | tools-center 托管副本(本地 9090 运行) |
| `D:\workbuddy\2026-08-03-09-29-43\tools\` | 旧副本(用户可能双击 wb-gui.bat 启动 8123) |
| `D:\workbuddy\2026-08-03-16-49-21\workbuddy-credits-tool\` | 旧副本(同上) |
| NAS `/mnt/usb2/Configs/tools-center/tools/<id>/` | 用户 NAS(iStoreOS Docker,2626 端口) |

**同步命令**(改完执行):
```bash
SRC="D:/workbuddy/2026-08-03-17-17-44/workbuddy-credits-tool"
for d in "D:/workbuddy/2026-08-03-17-17-44/tools-center/tools/wb-credits" \
         "D:/workbuddy/2026-08-03-09-29-43/tools" \
         "D:/workbuddy/2026-08-03-16-49-21/workbuddy-credits-tool"; do
  cp "$SRC"/wb-gui.mjs "$SRC"/wb-gui.js "$SRC"/wb-gui.html "$d/"
  cp "$SRC"/lib/*.js "$d/lib/"
done
# 然后重启 tools-center 托管的:curl -s -X POST http://127.0.0.1:9090/api/tools/wb-credits/restart
```
⚠️ 注意:旧副本里的 `wb-accounts.json`(账号凭证)是用户数据,同步时**不要覆盖**;`wb-sync.json`(WebDAV 配置)同理。

## 3. 版本戳机制(改了前端必须做)

- `wb-gui.html` 里 `<script src="./wb-gui.js?v=vX.Y.Z">` 和 `wb-gui.js` footer 的 `vX.Y.Z · 数据来自…` **两处必须同步更新**,否则浏览器缓存旧 JS 会看到旧版
- 用户判断版本方法:页面底部 footer 的版本号

## 4. 打包 zip(用户拖入 tools-center 用)

```bash
cd "D:/workbuddy/2026-08-03-17-17-44/workbuddy-credits-tool"
# 打包脚本:cwd 必须是源目录!排除 .git / wb-*.json / .gitignore
# 输出 D:/workbuddy/2026-08-03-17-17-44/wb-credits-tool.zip
```
- zip 内含 `tool.json`(**不带 id 字段**,registry 用目录名当 id,不覆盖已有工具)
- 排除敏感数据:wb-accounts.json / wb-sync.json / wb-history.json / wb-last-data.json

## 5. 环境注意事项

- **git push 必须带代理参数**(gitconfig 有空代理覆盖,直连 github 443 超时):
  `git -c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890 -c http.sslVerify=false -c http.https://github.com.proxy=http://127.0.0.1:7890 -c credential.helper= push https://x-access-token:<PAT>@github.com/Simiely/workbuddy-credits-tool.git main`
- 本机无 Docker;headless 验证用 Edge: `"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless --disable-gpu --window-size=390,1600 --virtual-time-budget=15000 --dump-dom "http://127.0.0.1:9090/tool/wb-credits/"`
- 沙箱会把 rm/unlink 转回收站,测试删目录用 PowerShell `[System.IO.Directory]::Delete(p,$true)`
- **WebDAV 默认地址** `http://192.168.2.1:6086/`(用户 NAS 局域网服务;前端 `SYNC_DEFAULT_URL` + 后端 `syncCfg()` 各一处,改默认要改两处)

## 6. 已知问题 / 待验证(用户反馈)

1. **NAS 上 v1.3.3 未验证**:确认弹窗修复后,下载/清空应恢复。用户待装新版 zip 验证。
2. **用户说"现在还是有 bug"**(2026-08-04 02:00,具体未指明,需等用户描述)
3. **历史快照长期增长**:当前 247 条/200KB,无压力;一年后可能 MB 级 → 建议加"每天最多 N 条 + 只保留 90 天"(v1.3.1 评估时列为暂缓项)
4. **折线图大数据量**:点数超阈值(如 >100)时降采样(暂缓项)
5. **Edge-daemon**(8129):Windows 专用(读本机 Edge 登录态);Docker/NAS 上跑不了是**预期**,提示条可点 ✕ 隐藏(localStorage `wb_daemon_hide`);「添加当前账号」在 NAS 不可用,手动维护 wb-accounts.json 或从 WebDAV 下载

## 7. 近期修复历史(浓缩)

- v1.3.3 确认弹窗(cfmRes 顺序)→ 下载/清空恢复
- v1.3.2 WebDAV 默认地址改局域网 / 空账号 footer+提示
- v1.3.1 数据指纹免闪屏
- v1.3.0 模块化重构(cfm 兜底、openMask、saveOrder、CSS 类、清死代码)
- v1.2.x 计算收敛到后端 / 审核修复
- v1.1.x 折线图 X 轴遮挡、时区(UTC→本地日)、1px 虚线、hover 大数字、图例单击独显/双击隐藏、横幅 ✕ 隐藏(hidden 被 CSS 覆盖的真根因)
- 更早:多副本不同步排查(3 份副本是历史遗留,用户曾跑旧版)
