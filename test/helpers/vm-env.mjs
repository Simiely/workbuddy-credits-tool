// test/helpers/vm-env.mjs — 前端 VM 集成测试环境工厂
// 在 node:vm 里模拟浏览器环境(document/window/localStorage/fetch/EventSource),
// 按 wb-gui.html 的加载顺序真实加载 7 个前端文件,用于回归"跨文件全局共享"行为。
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const FRONTEND_FILES = [
  "wb-gui.state.js",
  "wb-gui.core.js",
  "wb-gui.render.js",
  "wb-gui.chart.js",
  "wb-gui.ops.js",
  "wb-gui.sync.js",
  "wb-gui.actions.js",
];

function makeEl(id) {
  let _cls = [];
  const el = {
    id,
    textContent: "",
    value: "",
    hidden: false,
    innerHTML: "",
    dataset: {},
    style: {},
    checked: false,
    placeholder: "",
    onclick: null,
    addEventListener() {},
    focus() {},
    select() {},
    closest: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 100 }),
  };
  // className 与 classList 真实联动(否则 changeMode 的 active 状态无法断言)
  Object.defineProperty(el, "className", {
    get: () => _cls.join(" "),
    set: (v) => { _cls = String(v).split(/\s+/).filter(Boolean); },
  });
  Object.defineProperty(el, "classList", {
    value: {
      add: (c) => { if (c && !_cls.includes(c)) _cls.push(c); },
      remove: (c) => { _cls = _cls.filter((x) => x !== c); },
      contains: (c) => _cls.includes(c),
    },
  });
  return el;
}

/**
 * 创建并加载前端 VM 环境。
 * @param {object} opts
 * @param {Function} opts.fetch 后端模拟(mock 路由表), 形如 async (url, opts) => ({json})
 * @param {object} opts.els 预置元素(按 id)
 * @param {object} opts.localStorage localStorage 桩
 * @returns {{ run, el, els, toasts, calls, serverPass }}
 */
export function createFrontendEnv({ fetch: fetchMock, els: presetEls = {}, localStorage: lsMock = null } = {}) {
  const els = new Map();
  const toasts = [];
  const calls = { maskOpen: [], maskClose: [], adminBtn: 0, refresh: 0, closeSmall: 0 };
  const el = (id) => {
    if (!els.has(id)) els.set(id, presetEls[id] || makeEl(id));
    return els.get(id);
  };
  const toastEl = el("toast");
  const capToast = () => toastEl.textContent;

  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController,
    URL, TextEncoder, TextDecoder,
    fetch: fetchMock || (async () => ({ json: async () => ({ ok: true }) })),
    EventSource: class {
      constructor() { this._h = {}; }
      addEventListener(ev, fn) { this._h[ev] = fn; }
    },
    localStorage: lsMock || {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    window: { __BASE__: "" },
    document: {
      getElementById: el,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      body: makeEl("body"),
    },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    updateAdminBtn: () => { calls.adminBtn++; },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const run = (code) => vm.runInContext(code, sandbox, { filename: "test.js" });
  return { run, el, els, toasts, calls, capToast, sandbox, vm: sandbox };
}

/** 加载全部前端文件(按 html 引用顺序) */
export function loadFrontend(ctx, projectRoot) {
  for (const f of FRONTEND_FILES) {
    ctx.run(fs.readFileSync(path.join(projectRoot, f), "utf8"));
  }
}

/** 简易断言器 */
export function makeTester() {
  let passed = 0, failed = 0;
  const assert = (name, cond, extra = "") => {
    if (cond) { passed++; console.log("  PASS " + name); }
    else { failed++; console.log("  FAIL " + name + (extra ? "  << " + extra : "")); }
  };
  return {
    assert,
    report() {
      console.log(`\n===== ${passed} passed, ${failed} failed =====`);
      return failed === 0;
    },
  };
}
