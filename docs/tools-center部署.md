# Tools-Center 平台部署说明（平台版本标注）

> **本工具的平台版 = [tools-center](https://github.com/Simiely/tools-center) 统一宿主托管版本。**
> tools-center 是"轻量工具统一宿主":把你的工具以 **放目录 + 写 `tool.json`** 的方式挂载,平台统一托管进程、健康检查、崩溃自动拉起、日志聚合、`/tool/<id>` 反向代理,常驻 NAS。
>
> **双向标注**:tools-center 侧文档亦已标注本工具 —— `tools-center/README.md`「接入的工具」与 `docs/使用指南.md` 第十章「已接入示例:积分仪表盘(wb-credits)」。

---

## 一、与本工具其他版本的关系

| 版本 | 载体 | 采集方式 | 说明 |
|---|---|---|---|
| **平台版(本文)** | tools-center 托管(app) | **WebDAV 文件同步**(`WB_COLLECTOR=file`) | 容器无浏览器,凭证由桌面版上传 |
| exe 版 | Windows 单文件 | Edge 直采(内嵌 daemon) | 双击即用,数据在 exe 同目录 |
| 源码版 | Node 源码 | Edge CDP(edge-daemon) | 开发/自部署 |

三者共用同一套 `src/compute`(查询/派生/采样),数据文件格式一致,WebDAV 互通。

## 二、接入规范(对照 tools-center `docs/使用指南.md`)

### 目录结构

```
tools-center/
└── tools/
    └── wb-credits/          # id 与目录名一致
        ├── tool.json        # 工具声明(必须有)
        ├── wb-gui.mjs       # 服务端(监听端口)
        ├── wb-gui.html      # + 7 个前端 js(state/core/render/chart/ops/sync/actions)
        ├── src/             # 业务层
        ├── edge-daemon.mjs  # (平台版不启用,保留)
        ├── package.json / Dockerfile / docker-compose.yml(可选)
        └── credits.db / wb-*.json   # 运行数据(见"数据目录"节)
```

### tool.json 字段(本工具现状)

```json
{
  "id": "wb-credits",
  "name": "积分仪表盘",
  "desc": "WorkBuddy 多账号积分监控(独立仓库,平台托管)",
  "group": "WorkBuddy",
  "icon": "📉",
  "type": "app",
  "cmd": ["node", "wb-gui.mjs", "8123"],
  "cwd": ".",
  "port": 8123,
  "health": "/api/status"
}
```

| 字段 | 值 | 合规说明 |
|---|---|---|
| `id` | `wb-credits` | `[a-z0-9-]` ✅ |
| `type` | `app` | 平台 spawn 托管进程 ✅ |
| `cmd` | `["node","wb-gui.mjs","8123"]` | 末参=端口,`wb-gui.mjs` 从 argv 读 ✅ |
| `port` | `8123` | 在平台段 8100~8199 内 ✅ |
| `health` | `/api/status` | GET 返回 2xx ✅ |

> 平台兼容 V1 `tool.json`(与 `manifest.json` 等效,无需迁移)。

### 零输入上传(平台 v0.11.3+)

平台支持**纯 zip 上传即创建/更新工具**:网页「+ 添加」**不填任何字段**,直接把本部署包 zip 拖进弹窗 → 平台自动从 zip 内 `tool.json` 读取配置并创建、启动(同一 id 再传 = 覆盖升级)。
结合打包脚本 `pack-platform.mjs` 预填的 `wb-sync.json` → **上传后零输入、零操作,开箱即用**。

### 子路径挂载(平台已内置适配,勿回退)

工具在平台上以 `/tool/wb-credits/` 访问,本工具前端**已按平台约定适配**(AGENTS.md 关键坑 6):
- 页面资源:相对路径(`./wb-gui.core.js` 等)
- 内部 API:`__BASE__ + "/api/xxx"`(`wb-gui.html` 401 行已注入 `__BASE__` 检测,actions.js/core.js 全量使用)
- 独立运行时 `__BASE__` 为空,自动退化直连 —— 桌面版/exe 版不受影响

## 三、数据目录与安全(重要)

- **平台托管"工具目录即数据目录"**:`credits.db`(含账号凭证)与 `wb-*.json` 存在 `tools/wb-credits/` 下
- **删工具 = 删数据**:删除卡片/目录前务必先「☁️ 云同步 → 上传」备份;重装后重新配置 WebDAV 并「下载」恢复
- 凭证文件严禁外传;平台镜像/备份不含数据(见 `.dockerignore`)

## 四、部署与升级

```bash
# 部署(平台网页):「+ 添加」→ zip 上传(本包)或 Git 导入本仓库,平台自动识别 tool.json
# 或手动:整个目录放进 tools/wb-credits/ → 刷新首页 → 自动发现并启动

# 升级:替换 tools/wb-credits/ 下代码 → 平台卡片「↻ 重启」(或删目录重放,自动重拉起)
```

环境变量(可选,默认已合适合平台):`WB_COLLECTOR=file`、`TZ=Asia/Shanghai`(自然日固定 +8,不依赖进程时区)。

### 平台整体升级(重部署)后,工具自动恢复 ✅

> **结论:拉取最新 tools-center 镜像重部署(`docker compose pull && docker compose up -d --force-recreate`),本工具照常运行,数据不丢,无需重新配置。**

三层保障:

| 保障 | 说明 |
|---|---|
| **挂载卷不丢数据** | `tools/` 与 `data/` 是独立挂载卷,容器重建只换平台代码,`tools/wb-credits/`(程序 + `credits.db` 凭证 + `wb-*.json`)原样保留 |
| **自动发现 + 自动拉起** | 平台启动即扫描 `tools/*/tool.json` → 本工具自动进入"托管中"并在 8123 拉起,无需重新「+ 添加」 |
| **配置向后兼容** | 新版平台新增的 `dataFiles`、`settings.json` 等均为可选字段:老配置没有 → 走默认值(数据识别用通用规则 `*.db*`、模块默认全开),不报错不禁用 |

注意事项:
- 平台更新命令必须是 `pull && up -d --force-recreate` 连着执行(只 pull 不重启 = 仍跑旧代码,易误判"没更新")
- 旧容器停止后端口 8123 自动释放,新容器自动接管
- 若希望存储管理的**数据识别更精确**(`wb-accounts.json` 等也归数据),请使用带 `dataFiles` 声明的**最新平台版 zip**(v1.4.41+ 自带);不更新也不影响运行,通用规则仍能识别 `*.db*`
- 首次部署/重装后 `settings.json` 不存在 → 平台模块默认全开,功能完整

## 五、cookie 更新(平台版核心注意)

平台版**不能采集 cookie**(容器无浏览器),数据真相源靠桌面版:

```
桌面版(exe/源码):Edge 重新登录 → 「＋ 添加当前账号」→ 「☁️ 上传」
平台版:          「☁️ 云同步 → 下载」→ 凭证/历史更新
```

详见 `docs/新手使用手册.md` 第 8 节与 `docs/部署.md`。

## 六、文档索引(标注)

| 文档 | 内容 |
|---|---|
| 本文 | **tools-center 平台部署标注**(接入规范/目录/数据/升级) |
| `docs/部署.md` | 桌面 / Docker 通用部署 |
| `docs/新手使用手册.md` | 面向最终用户的使用说明 |
| `docs/问题记录/` | 踩坑记录(400 CookieTooLarge / 串号 / 签到误判) |
