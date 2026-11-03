// tests/usage.test.mjs —— 「卡片只报总余额，不写每日上限」
//
// 站点的 dailyLimit（1 亿/天）是内置的「今天最多能花多少」，几乎永远用不完。
// 把它写进卡片，进度条永远满格，用户看不到「我还有多少」。
// 所以主窗口只报 wallet.balance；只有真的用尽了，才加一行「已用尽 · N 小时后恢复」。

import test from "node:test"
import assert from "node:assert/strict"

import { buildUsage, hoursUntilReset, nextBeijingMidnight } from "../src/usage.mjs"

const wallet = { balance: 37_863_140, totalEarned: 37_864_996, totalSpent: 1_856 }
const tasks = { tasks: [{ id: "message_wall", claimed: true, enabled: true }] }

const make = (usedToday, dailyLimit = 100_000_000) =>
  buildUsage({
    dashboard: { wallet, usage: { usedToday, dailyLimit }, benefits: tasks },
    me: { level: 1 },
    accountName: "MYCF711",
  })

test("主窗口是总余额（钱包型），没有 amount/limit 分母", () => {
  const main = make(1_856).windows[0]
  assert.equal(main.name, "Token 余额")
  assert.equal(main.balance, 37_863_140)
  assert.equal(main.amount, undefined, "不能给 amount")
  assert.equal(main.limit, undefined, "不能给 limit")
})

test("没用到上限时，卡片上不出现「上限」字样", () => {
  const text = JSON.stringify(make(1_856))
  assert.doesNotMatch(text, /上限/)
  assert.doesNotMatch(text, /100000000|1 亿/)
  assert.equal(make(1_856).windows.some((w) => w.name === "今日额度"), false)
})

test("真的用尽当日额度 → 一行「已用尽 · N 小时后恢复」", () => {
  const { windows } = make(100_000_000)
  const hit = windows.find((w) => w.name === "今日额度")
  assert.ok(hit, "用尽时必须出现这一行")
  assert.match(hit.display, /已用尽/)
  assert.match(hit.display, /小时后恢复/)
  assert.equal(hit.aside, true, "不参与路由")
  assert.equal(hit.text, true, "作为文字显示")
})

test("超过上限（站点可能允许）同样算用尽", () => {
  const { windows } = make(120_000_000)
  assert.ok(windows.find((w) => w.name === "今日额度"))
})

test("窗口整体能过 quota 构造器，且至少一条可参与路由", () => {
  const usage = make(1_856)
  assert.ok(usage.windows.length >= 2)
  const routable = usage.windows.filter((w) => w.aside !== true && (w.used !== undefined || w.balance !== undefined))
  assert.ok(routable.length >= 1)
})

test("北京时间 0 点：ISO 正确，小时数向上取整且至少 1", () => {
  assert.equal(nextBeijingMidnight(Date.parse("2026-11-03T10:00:00+08:00")), "2026-11-03T16:00:00.000Z")
  assert.equal(hoursUntilReset(Date.parse("2026-11-03T23:30:00+08:00")), 1)
  assert.equal(hoursUntilReset(Date.parse("2026-11-03T10:00:00+08:00")), 14)
})

// ── 邀请码那一格 ────────────────────────────────────────────────────
//
// `GET /api/invite` 是「有更好、没有也照样出卡」的只读信息：
// 读到了就补一行文字，读不到（没有 cookie / 接口抖动）整格不出现，
// 绝不能因为它少一行主要额度。

test("邀请码：读到了就一行文字窗口，且不参与路由", () => {
  const usage = buildUsage({
    dashboard: { wallet, usage: { usedToday: 1_856, dailyLimit: 100_000_000 }, benefits: tasks },
    me: { level: 1 },
    invite: { code: "ABCD1234", invitedCount: 2, paidCount: 1, tokenRewardTotal: 20_000_000 },
  })
  const hit = usage.windows.find((w) => w.name === "邀请码")
  assert.ok(hit, "有码时必须出现这一格")
  assert.match(hit.display, /ABCD1234/)
  assert.match(hit.display, /已邀 2/)
  assert.match(hit.display, /付费 1/)
  assert.equal(hit.aside, true, "不参与路由")
  assert.equal(hit.text, true, "作为文字显示")
  assert.equal(hit.balance, undefined, "不是额度窗口")
})

test("邀请码：没有码（或没登录）就整格消失，不留空行", () => {
  const base = { wallet, usage: { usedToday: 1_856, dailyLimit: 100_000_000 }, benefits: tasks }
  for (const invite of [undefined, null, {}, { code: "" }, { code: "   " }]) {
    const usage = buildUsage({ dashboard: base, me: { level: 1 }, invite })
    assert.equal(
      usage.windows.some((w) => w.name === "邀请码"),
      false,
      `invite=${JSON.stringify(invite)} 时不该出现邀请码那一格`,
    )
  }
})

test("邀请码：没有邀请记录时只显示码，不编造统计", () => {
  const usage = buildUsage({
    dashboard: { wallet, usage: { usedToday: 1_856, dailyLimit: 100_000_000 }, benefits: tasks },
    me: { level: 1 },
    invite: { code: "ABCD1234" },
  })
  const hit = usage.windows.find((w) => w.name === "邀请码")
  assert.equal(hit.display, "邀请码 ABCD1234")
  assert.doesNotMatch(hit.display, /已邀|付费|奖励/)
})
