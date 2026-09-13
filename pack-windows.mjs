// pack-windows.mjs - Windows 桌面版(bat)打包脚本
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.argv[2] || "C:/Temp/trae-releases";
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VER = pkg.version;
const ZIP_NAME = `trae-credits-tool-bat版-v${VER}.zip`;
const OUT = path.join(OUT_DIR, ZIP_NAME);
const STAGE = path.join(ROOT, ".tmp-windows-pack");
const shellSync = { url: "", user: "", pass: "" };

fs.mkdirSync(STAGE, { recursive: true });

// Windows 桌面版 = 源码 + 双击即用的 bat 启动器（端口 8080，数据落 bat 同目录）
const rootFiles = [
  "trae-gui.mjs", "trae-credits.mjs",
  "trae-gui.bat", "trae-credits.bat",
  "wb-gui.html", "wb-gui.state.js", "wb-gui.core.js", "wb-gui.render.js",
  "wb-gui.chart.js", "wb-gui.ops.js", "wb-gui.sync.js", "wb-gui.actions.js",
  "package.json", "tool.json", "README.md", "CHANGELOG.md",
];
for (const f of rootFiles) {
  const s = path.join(ROOT, f);
  if (fs.existsSync(s)) fs.copyFileSync(s, path.join(STAGE, f));
}
fs.cpSync(path.join(ROOT, "src"), path.join(STAGE, "src"), { recursive: true });
fs.writeFileSync(path.join(STAGE, "wb-sync.json"), JSON.stringify(shellSync, null, 2), "utf8");

const readme = `# Windows 桌面版部署说明(双击即用)

> TRAE/WorkBuddy 积分管理 · Windows 桌面版 v${VER}
> **Windows 桌面版 = 源码 + bat 一键启动**:解压后双击 \`trae-gui.bat\` 即拉起服务。

## 零输入说明
本包 **未预填 WebDAV 配置**(\`wb-sync.json\` 为空壳):
1. 双击 \`trae-gui.bat\` → 自动打开 http://127.0.0.1:8080
2. 首次使用「📥 导入凭证/账号」扫描本机 TRAE 登录态/槽,或导入 MultiSwitch「🔑导出凭证」json
3. 点「刷新全部」→ 查询积分;WebDAV 同步在「☁️ 云同步 → 配置」填地址/账号/密码

## 配置要求
- Node.js ≥ 18(内置 node:sqlite,推荐 22+);bat 优先用 PATH 的 node,否则回退 WorkBuddy 受管 Node。
- 数据目录 = bat 同目录:\`credits.db\` / \`trae-*.json\`,**删目录 = 删数据**,先云同步备份。

## 与平台版区别
- 桌面版端口 8080、双击启动、数据在本机目录;
- 平台版端口 8133、由 tools-center 托管(\`node trae-gui.mjs 8133\`),数据在平台工具目录。

## 升级
解压覆盖原目录代码即可(保留 \`credits.db\` / \`trae-*.json\` 不丢数据)。
`;
fs.writeFileSync(path.join(STAGE, "Windows部署说明.md"), readme, "utf8");

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
console.log(`windows zip: ${OUT}`);
