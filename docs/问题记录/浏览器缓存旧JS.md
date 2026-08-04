# 问题:浏览器缓存旧 JS,修了但"看不到效果"

**TL;DR**:GUI 服务对页面/JS 响应无缓存控制,浏览器缓存了修复前的旧代码,导致代码已修但界面表现依旧。

- 问题:修完 bug、无头浏览器实测正常,用户浏览器上仍复现旧行为(如刷新一直转)
- 根因:浏览器 HTTP 缓存把旧 `wb-gui.js`(现已拆为 `wb-gui.{state,core,render,actions}.js` 4 个文件)缓存在本地,新请求直接命中缓存
- 解决:GUI 服务对 `/` 与 `/wb-gui.state.js`/`wb-gui.core.js`/`wb-gui.render.js`/`wb-gui.actions.js` 响应加 `Cache-Control: no-store`,浏览器永远拿最新代码(文件名变更后缓存也会自然失效)
- 预防:任何"改代码 → 前端页面"的服务都要考虑缓存;验证问题时先排除浏览器缓存,再看 Console
