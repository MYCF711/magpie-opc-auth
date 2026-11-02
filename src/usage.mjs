// src/usage.mjs —— 额度卡片
//
// 这个站点有两种「额度」，别混（页面上就是分开展示的）：
//
//   wallet.balance        账户里的 Token 余额（用一点少一点，**不会每日重置**）
//   usage.dailyLimit      每日最多能消耗多少（默认 1 亿，北京时间 0 点重置）
//
// 卡片上两个窗口都给：钱包型给余额，数量型给今日用量占比。
// 任务进度（4 个每日任务领了几个）是纯文字窗口，不参与路由。

import { usage as quotaUsage, usageWindow } from "./quota.mjs"
import { ROUTES } from "./context.mjs"

const fmt = (n) => {
  const v = Number(n)
  if (!Number.isFinite(v)) return "0"
  if (v >= 1e8) return `${(v / 1e8).toFixed(2).replace(/\.00$/, "")} 亿`
  if (v >= 1e4) return `${(v / 1e4).toFixed(1).replace(/\.0$/, "")} 万`
  return v.toLocaleString("zh-CN")
}

/** 下一个北京时间 0 点的 ISO 字符串（服务器按北京时间日切） */
export function nextBeijingMidnight(now = Date.now()) {
  const tz = 8 * 3600_000
  const local = now + tz
  const dayMs = 24 * 3600_000
  const nextLocal = Math.floor(local / dayMs) * dayMs + dayMs
  return new Date(nextLocal - tz).toISOString()
}

/** 距离下一个北京时间 0 点还有几小时（向上取整，至少 1） */
export function hoursUntilReset(now = Date.now()) {
  const next = Date.parse(nextBeijingMidnight(now))
  return Math.max(1, Math.ceil((next - now) / 3600_000))
}

/** 任务进度一句话 */
export function benefitSummary(dashboard) {
  const tasks = dashboard?.benefits?.tasks || []
  if (!tasks.length) return ""
  const claimed = tasks.filter((t) => t.claimed).length
  const names = { message_wall: "寄语墙", plaza_post: "发帖", project_publish: "项目", requirement_publish: "需求" }
  const pending = tasks
    .filter((t) => !t.claimed && t.enabled)
    .map((t) => names[t.id] || t.id)
    .join("、")
  return pending ? `${claimed}/${tasks.length} 已领取 · 待做：${pending}` : `${claimed}/${tasks.length} 全部已领取`
}

/**
 * @param {object} p
 * @param {object} p.dashboard  /api/model-service 的返回
 * @param {object} p.me         /api/auth/me 的返回（可空）
 * @param {string} p.accountName
 */
export function buildUsage({ dashboard, me, accountName }) {
  const wallet = dashboard?.wallet || {}
  const used = dashboard?.usage || {}
  const balance = Number(wallet.balance) || 0
  const usedToday = Number(used.usedToday) || 0
  const dailyLimit = Number(used.dailyLimit) || 0

  const plan = me?.level ? `Lv.${me.level}` : "FiimeOPC"
  const user = accountName || me?.username || ""

  const windows = []

  // ── 主额度 = 账号总余额（wallet.balance）──────────────────────────
  //
  // ⚠ 不写每日上限。`usage.dailyLimit` 是站点内置的「今天最多能花多少」，
  //   它几乎永远用不完；写进卡片只会让进度条永远满格，用户看到的不是「我还有多少」。
  //   这一格只回答一件事：这个账号里还有多少 Token。
  windows.push(
    usageWindow({
      name: "Token 余额",
      balance,
      unit: "Token",
      display: `${fmt(balance)} Token`,
    }),
  )

  // 只有**真的用尽**了当日额度才提一句「用尽 + 何时恢复」；其余时候连「上限」都不出现。
  if (dailyLimit > 0 && usedToday >= dailyLimit) {
    windows.push(
      usageWindow({
        name: "今日额度",
        used: 100,
        aside: true,
        text: true,
        display: `已用尽 · ${hoursUntilReset()} 小时后恢复`,
      }),
    )
  }

  const summary = benefitSummary(dashboard)
  if (summary) {
    windows.push(
      usageWindow({
        name: "今日任务",
        // 文本窗口：magpie 认 `text: true` + `display`（HOOKS 三 · 判据）；
        // used: 0 + aside: true 表示「不参与路由、用光也不停号」。
        used: 0,
        aside: true,
        text: true,
        display: summary,
      }),
    )
  }

  return quotaUsage({
    plan,
    ...(user ? { user } : {}),
    windows,
  })
}

/** 只有 cookie 没有 API Key 时，额度照读；但模型通道那行要说明白 */
export function channelNote(hasKey) {
  return hasKey
    ? "模型通道已就绪（Bearer API Key）"
    : `模型通道还差一把 API Key：到 ${ROUTES.keys} 创建，或用 Cookie 登录让插件自动建`
}
