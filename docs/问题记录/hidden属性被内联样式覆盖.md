# hidden 属性被内联样式覆盖(云同步快捷按钮一直显示)

> **TL;DR**:元素同时带 `hidden` 属性和内联 `style="display:flex"` 时,内联样式优先级更高 → `hidden` 失效,未配置 WebDAV 也显示「测试/上传/下载」。修复:去掉内联样式,加 CSS `[hidden]{display:none !important}`。

## 问题

- 现象:云同步快捷按钮(测试/上传/下载)在**未配置 WebDAV** 时也一直显示,违背"验证通过才显示"的设计。
- 代码:JS 的 `showSyncQuick()`(移除 hidden)和启动检测逻辑都对,但按钮就是隐藏不了。

## 根因

```html
<span id="syncQuick" hidden style="display:flex;gap:8px">
```

- `hidden` 属性依赖浏览器 UA 样式 `[hidden]{display:none}`
- 内联 `style="display:flex"` **优先级高于 UA 样式** → 元素始终 `display:flex`,`hidden` 形同虚设

## 解决(v1.0.4)

```css
#syncQuick { display:flex; gap:8px }            /* 显示时 flex 布局 */
#syncQuick[hidden] { display:none !important }  /* 隐藏时强制隐藏 */
```

去掉元素上的内联 `style="display:flex"`。

## 预防

- 同一元素**不要同时**用 `hidden` 属性 + 内联 `display` 样式
- 两种稳妥写法:①只用 JS 控制 `el.style.display`;②HTML 只写 `hidden`,CSS 用 `[hidden]{display:none !important}` 兜底
