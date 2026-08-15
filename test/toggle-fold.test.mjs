// test/toggle-fold.test.mjs — 面板折叠回归:标题内可交互元素(截止日期输入框等)不触发折叠
// 回归背景(v1.4.64):trendEnd 日期输入框位于 .phead.foldable 标题内,toggleFold 原守卫只排除
// button → 点击输入框冒泡触发折叠,趋势面板被意外收起。修复为排除 button/input/select/textarea/label/a。
// 运行: node test/toggle-fold.test.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFrontendEnv, loadFrontend, makeTester } from "./helpers/vm-env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const ctx = createFrontendEnv();
loadFrontend(ctx, ROOT);
const { run } = ctx;
const { assert, report } = makeTester();

// 造一个 phead(head)与三种点击目标:
// - inp : 命中 input 选择器(模拟截止日期输入框)
// - btn : 命中 button 选择器(模式切换按钮,原守卫已覆盖,防回归)
// - txt : 普通标题文本(应正常折叠)
run(`
  window.__head = { dataset: { fold: "trend" }, classList: {
    _c: [],
    add(c){ if(!this._c.includes(c)) this._c.push(c); },
    remove(c){ this._c = this._c.filter(x=>x!==c); },
    contains(c){ return this._c.includes(c); },
    toggle(c){ this.contains(c) ? this.remove(c) : this.add(c); return this.contains(c); }
  }};
  window.__inp = { closest: (s) => (s.indexOf("input") >= 0 ? {} : null) };
  window.__btn = { closest: (s) => (s.indexOf("button") >= 0 ? {} : null) };
  window.__txt = { closest: () => null };

  window.__head.classList.remove("folded");
  toggleFold(window.__head, { target: window.__inp });
  window.__r1 = window.__head.classList.contains("folded");

  window.__head.classList.remove("folded");
  toggleFold(window.__head, { target: window.__btn });
  window.__r2 = window.__head.classList.contains("folded");

  window.__head.classList.remove("folded");
  toggleFold(window.__head, { target: window.__txt });
  window.__r3 = window.__head.classList.contains("folded");

  // 再次点文本应能展开(折叠→展开往返)
  toggleFold(window.__head, { target: window.__txt });
  window.__r4 = window.__head.classList.contains("folded");
`);

assert("点截止日期输入框不折叠", run(`window.__r1`) === false);
assert("点模式切换按钮不折叠(原守卫)", run(`window.__r2`) === false);
assert("点标题文本触发折叠", run(`window.__r3`) === true);
assert("再点标题文本展开(往返正常)", run(`window.__r4`) === false);

process.exit(report() ? 0 : 1);
