// src/checkin.mjs —— 每日签到（= 跑一轮每日任务）
//
// 站点没有「点一下签到」的接口：它的签到就是 4 个每日任务（寄语墙 / 发帖 / 项目 / 需求）。
// 所以这个钩子做的事是：**先看状态，只做还能换到奖励的那几条**（判断逻辑在 src/tasks.mjs）。
//
// 契约（HOOKS 二）：outcome 只能是 claimed / done / ineligible / inactive / captcha / failed。
// magpie 每账号每天（北京时间）调用一次，当天失败还会再调一次 —— 所以这里必须幂等：
// 已领的直接报 done，绝不重复发布内容。

import { runDailyTasks } from "./tasks.mjs"

/**
 * @param {object} p
 * @param {string} p.cookie
 * @param {object} [p.options]
 * @param {string} [p.signature]
 * @param {string} [p.accountKey]
 * @returns {Promise<{outcome:string, credit?:number, message:string}>}
 */
export async function doCheckin({ cookie, options, signature = "", accountKey = "default" }) {
  const { results, reward, message } = await runDailyTasks({
    cookie,
    options,
    signature,
    accountKey,
  })

  if (!results.length) return { outcome: "inactive", message: "站点没有返回每日任务" }

  const claimed = results.filter((r) => r.status === "claimed")
  const failed = results.filter((r) => r.status === "failed" || r.status === "claim-failed")
  const done = results.filter((r) => r.status === "done")

  if (claimed.length) {
    return { outcome: "claimed", ...(reward ? { credit: reward } : {}), message }
  }
  if (failed.length && !done.length) {
    return { outcome: "failed", message }
  }
  if (done.length || results.every((r) => r.status === "done" || r.status === "skip")) {
    return { outcome: "done", message }
  }
  return { outcome: "ineligible", message }
}
