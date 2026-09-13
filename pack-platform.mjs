// pack-platform.mjs - 平台版打包脚本(tools-center 部署包)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.argv[2] || "C:/Temp/trae-releases";
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VER = pkg.version;
const ZIP_NAME = `trae-credits-tool-平台版-v${VER}.zip`;
const OUT = path.join(OUT_DIR, ZIP_NAME);
const STAGE = path.join(ROOT, ".tmp-platform-pack");
const shellSync = { url: "", user: "", pass: "" };

fs.mkdirSync(STAGE, { recursive: true });
fs.mkdirSync(path.join(STAGE, "docs"), { recursive: true });

const rootFiles = [
  "trae-gui.mjs", "trae-credits.mjs",
  "wb-gui.html", "wb-gui.state.js", "wb-gui.core.js", "wb-gui.render.js",
  "wb-gui.chart.js", "wb-gui.ops.js", "wb-gui.sync.js", "wb-gui.actions.js",
  "package.json", "tool.json", "Dockerfile", "docker-compose.yml",
  ".dockerignore", "README.md", "CHANGELOG.md",
];
for (const f of rootFiles) {
  const s = path.join(ROOT, f);
  if (fs.existsSync(s)) fs.copyFileSync(s, path.join(STAGE, f));
}
fs.cpSync(path.join(ROOT, "src"), path.join(STAGE, "src"), { recursive: true });
fs.writeFileSync(path.join(STAGE, "wb-sync.json"), JSON.stringify(shellSync, null, 2), "utf8");

const binaryToText = { "发布规范.md": "每次发包只发两个形态:平台版 + bat 版。", "tools-center部署.md": "见 tool.json:app 型,端口 8133,「/api/status」健康检查,平台自动拉起 `node trae-gui.mjs 8133`。", "配置要求.md": "必填 WebDAV 三项;端口 8133;数据目录即工具目录,删工具=删数据,先云同步备份。" };
for (const [fn, body] of Object.entries(binaryToText)) {
  fs.writeFileSync(path.join(STAGE, "docs", fn), `# ${fn.replace(".md", "")}\n\n${body}\n\n(自动生成 v${VER})\n`, "utf8");
}

const readme = `# 平台版部署说明(tools-center 托管)

> TRAE/WorkBuddy 积分管理 · 平台版 v${VER}
> **平台版 = tools-center 统一宿主托管**:网页「+ 添加」→ zip 上传本包,平台自动识别 \`tool.json\` 并托管进程。

## 零输入说明
本包 **未预填 WebDAV 配置**(公开包 \`wb-sync.json\` 为空壳):
1. 平台自动拉起 \`node trae-gui.mjs 8133\`(健康检查 \`/api/status\`)
2. 打开 \`/tool/trae-credits/\` → 「☁️ 云同步 → 配置」填 WebDAV 地址/账号/密码 → 「🔄 同步 → 下载」

## 配置要求
见包内 \`docs/配置要求.md\`(必填 WebDAV 三项;端口 8133 tool.json 已声明)。

## 数据与凭证
- 数据目录 = 工具目录(\`tools/trae-credits/\`):\`credits.db\` 含凭证,**删工具 = 删数据**,先云同步备份。
- 指纹更新:桌面版采集/导入账号 → 「☁️ 上传」→ 平台版「下载」。

## 升级
替换 \`tools/trae-credits/\` 下代码 → 平台卡片「↻ 重启」。

## 文档
\`docs/tools-center部署.md\`(接入规范)/ \`docs/配置要求.md\`(配置清单)/ \`docs/发布规范.md\`(发包流程)
`;
fs.writeFileSync(path.join(STAGE, "平台部署说明.md"), readme, "utf8");

if (fs.existsSync(OUT)) fs.rmSync(OUT);
const py = [
  "import zipfile,os,sys",
  "root=os.path.abspath(sys.argv[1])",
  "out=sys.argv[2]",
  "z=zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED)",
  "for r,_,fs in os.walk(root):",
  "    for f in fs:",
  "        p=os.path.join(r,f)",
  "        rel=os.path.relpath(p,root).replace(os.sep,'/')",
  "        z.write(p,rel)",
  "z.close()",
];
execFileSync("python", ["-c", py.join("\n"), STAGE, OUT], { stdio: "inherit", cwd: STAGE });
console.log(`platform zip: ${OUT}`);
