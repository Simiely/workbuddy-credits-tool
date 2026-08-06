# 账号查询全部 400:Request Header Or Cookie Too Large

## 现象

2026-08-06:账号池全部账号查询失败,报错 `接口响应非 JSON(HTTP 400):可能是被拦截或接口变更`。

## 排查

1. 首页 `https://www.workbuddy.cn/` 直连/代理均 200 → 排除网络层。
2. 用真实 cookie 手动调 `POST /billing/meter/get-user-resource` → 网关 stgw 返回 **400 Request Header Or Cookie Too Large**(text/html 不是 JSON,所以 client.js 报"非 JSON")。
3. 打印 cookieHeader:单账号 **30 段 / 14KB**,远超网关请求头上限(约 8KB)。

## 根因

`edge-collector.js` 的 `_getEdgeCookies()` 用 `Network.getAllCookies` 把 **workbuddy.cn 域下全部 cookie 拼进 header**,混入三类垃圾:

- **Keycloak 一次性登录令牌**:`KC_RESTART`(单段 1KB+)、`KC_STATE_CHECKER` —— API 请求根本不需要,浏览器只在登录端点才发
- **广告/埋点跟踪 cookie**:`_gcl_au` / `sensorsdata2015jssdkcross` / `_TDID_CK` / `trafficParams` / `qcloud_from` / `qcloud_visitId` / `i18next` / `login_risk_state` / `9c412d6095037d16`(风控指纹)
- **多会话残留同名 cookie**:多次登录/换账号后浏览器里残留多套 `KEYCLOAK_IDENTITY` / `AUTH_SESSION_ID` / `session`(同名多份,值还不同)

## 修复(v1.4.39 前,双处)

### 治本:采集端 `src/collect/edge-collector.js`
`Network.getAllCookies` → **`Network.getCookies({ urls: [tab.url] })`**:按当前页面 URL 精确取"浏览器真正会发送的 cookie",自动按 domain/path/secure 过滤、按名去重,不再混入登录端点/跟踪 cookie。`getCookies` 无结果时兜底回退 `getAllCookies`(仍会被查询端清洗)。

### 治标:查询端 `src/compute/client.js`
新增 `sanitizeCookieHeader()` 并在 `fetchCredits()` 入口调用,对**历史脏数据即时生效**(无需用户重新添加账号):

1. 剔除黑名单前缀:`KC_RESTART` / `KC_STATE_CHECKER` / `9c412d6095037d16` / `_TDID_CK` / `_gcl_au` / `trafficParams` / `sensorsdata` / `qcloud_` / `i18next` / `login_risk_state`
2. 同名去重(保留最后一份)
3. 兜底:清洗后仍 > 7KB 降级为认证核心白名单(`KEYCLOAK_IDENTITY` / `KEYCLOAK_SESSION` / `AUTH_SESSION_ID` / `session` / `session_2`)

### 数据:持久化清洗
清洗脚本遍历 `credits.db` accounts 表,`UPDATE cookieHeader` 写回(备份 `credits.db.bak-20260806`)。6/6 账号 9~14KB → 3~5.6KB。

## 实验验证

| 组合 | 长度 | 结果 |
|---|---|---|
| 原始(30 段混杂) | 14139B | 400 Cookie Too Large |
| 按名去重 | 6771B | 200,code=0 |
| 认证核心白名单 | 3998B | 200,code=0 |
| 仅 KEYCLOAK_IDENTITY | 618B | 401(凭证失效,需 session cookie 配合) |

## 遗留注意

- 已清洗的两个副本 db 的 `wb-accounts.json` 镜像仍是旧脏数据(WebDAV 上传会重新 exportLegacy 覆盖,无需手改;WebDAV 下载会 importLegacy 覆盖 db —— 若远端镜像脏,下载后需再跑一次清洗)。
- stgw 请求头上限约 8KB,`MAX_COOKIE_BYTES=7000` 留余量;若官方新增认证 cookie,白名单需同步更新。
