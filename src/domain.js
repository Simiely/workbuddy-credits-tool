// src/domain.js - 领域模型（程序真正的核心，四实体）
//
// 这是「额度遥测管线」的词汇表。所有计算/展示都围绕这四个实体，
// 而不是散落在各处的匿名对象。P2 的派生引擎与 P4 的告警都消费这里定义的形状。
//
//   Account  : 账号身份 + 凭证（accounts 表）
//   Reading  : 某时刻的不可变快照（readings 表，append-only，唯一真相源）
//   Derived  : 由 Readings 派生（currentRemain / todayUsed / dailyUsed / 赠送包到期）—— P2 产出
//   Alert    : 告警事件（P4 产出）
//
// 本文件只放「形状」相关工具；不碰 IO（IO 在 src/store）。

/**
 * @typedef {Object} Account
 * @property {string} id
 * @property {string} name        手机号 / 原名称
 * @property {string} uin         去重主键（探测所得）
 * @property {string} cookieHeader 凭证（敏感，不向前端明文暴露）
 * @property {string} [userAgent]
 * @property {string|null} sessionExpiresAt
 * @property {string} [displayName]
 * @property {string} [lastStatus] ok | expired | error
 * @property {string} [source]     legacy | edge | file
 * @property {string} [addedAt]
 * @property {string} [updatedAt]
 */

/**
 * @typedef {Object} Reading
 * @property {string} uin
 * @property {string} ts          ISO 时间戳
 * @property {number} baseRemain
 * @property {number} baseUsed
 * @property {number} giftRemain
 * @property {number} giftUsed
 * @property {string} [raw]       原始 entry JSON（精确回放用）
 */

/**
 * 规范化一个账号对象，补齐所有字段，便于 INSERT。
 * @param {Partial<Account>} a
 * @param {number} [orderIdx]
 * @returns {Account & {order_idx:number}}
 */
export function normalizeAccount(a, orderIdx = 0) {
  a = a || {};
  return {
    id: a.id || `acc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: a.name || "",
    uin: a.uin || "",
    cookieHeader: a.cookieHeader || "",
    userAgent: a.userAgent || "",
    sessionExpiresAt: a.sessionExpiresAt || null,
    displayName: a.displayName || "",
    lastStatus: a.lastStatus || "ok",
    source: a.source || "legacy",
    addedAt: a.addedAt || new Date().toISOString(),
    updatedAt: a.updatedAt || new Date().toISOString(),
    order_idx: orderIdx,
  };
}

/**
 * 把 accounts 表的一行映射回 Account 对象（剔除内部 order_idx）。
 * @param {Object} row
 * @returns {Account}
 */
export function rowToAccount(row) {
  return {
    id: row.id,
    name: row.name,
    uin: row.uin,
    cookieHeader: row.cookieHeader,
    userAgent: row.userAgent,
    sessionExpiresAt: row.sessionExpiresAt,
    displayName: row.displayName,
    lastStatus: row.lastStatus,
    source: row.source,
    addedAt: row.addedAt,
    updatedAt: row.updatedAt,
  };
}
