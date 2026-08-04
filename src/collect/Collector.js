// src/collect/Collector.js - 采集层契约（策略接口）
// 两套技术方案只在"采集"这一步分叉：
//   - EdgeCollector：桌面，经 edge-daemon 读本机 Edge 登录态 → 产出单账号凭证
//   - FileCollector：Docker/NAS，从 WebDAV 下载 wb-accounts.json → 同步整个账号池
// 两者对上层暴露统一的采集结果形状，计算层/展示层完全不感知差异。
export class Collector {
  constructor(scheme) {
    this.scheme = scheme;
  }

  /**
   * 采集"当前账号"（桌面方案）。返回 { cookieHeader, sessionExpiresAt, name }
   * @param {string} [_remark] 备注名（优先于页面提取的手机号）
   */
  async captureCurrentAccount(_remark) {
    throw new Error("captureCurrentAccount 未实现");
  }

  /**
   * 从外部源同步整个账号池（Docker 启动方案）。返回 { count, restored }
   * @param {object} [_cfg] WebDAV 配置（缺省读本地）
   */
  async syncFromWebDAV(_cfg) {
    throw new Error("syncFromWebDAV 未实现");
  }
}
