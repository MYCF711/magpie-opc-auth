// src/checkin.mjs —— 每日签到
//
// 这个站点的「签到」就是「寄语墙任务」：每天发一条 ≥20 字的寄语，领 1000 万 Token。
// 实测（2026-11-03，真实账号）：
//   · 任务 cadence=daily，每天 0 点重置；累计上限 30 次（maxClaims）
//   · 发完寄语后 completed=true、claimable=true，**当天可以立刻领**
//   · 删除寄语不会退回已领的 Token（claimed 仍为 true）
//
// outcome 只能是 claimed / done / ineligible / inactive / captcha / failed 六个之一。

import { claimBenefit, fetchDashboard, publishNote } from "./api.mjs"

const TEMPLATES = [
  "今日签到。把注意力放回手上那件真正想做的事，慢一点也没关系。",
  "签到。做产品像种树，今天浇水，明天不用急着看它长高。",
  "今日打卡：允许自己今天只前进一小步，这也算前进。",
  "签到。每天做一点，久了就成了一件像样的事。",
  "今日签到。把复杂的事拆开，一次只解决一格。",
  "签到。愿每个认真做东西的人，都能被看见、被回应。",
  "今日打卡。把今天过好，就已经是在为明天做准备。",
  "签到。灵感来的时候记下来，走了也别慌，它还会回来。",
]

const MIN_LEN = 20
const MAX_LEN = 160

/** 按日期轮换文案，避免每天同一句撞上去重 */
export function pickText(seed = Date.now()) {
  const day = Math.floor((seed + 8 * 3600_000) / 86_400_000)
  return TEMPLATES[day % TEMPLATES.length]
}

/**
 * @param {object} p
 * @param {string} p.cookie
 * @param {object} p.options  { checkinTask, checkinText }
 * @param {string} p.signature  署名（账号名）
 */
export async function doCheckin({ cookie, options, signature = "" }) {
  const taskId = options?.checkinTask || "message_wall"

  const dashboard = await fetchDashboard(cookie)
  const task = (dashboard?.benefits?.tasks || []).find((t) => t.id === taskId)
  if (!task) return { outcome: "inactive", message: `站点没有 ${taskId} 这个任务` }
  if (task.claimed) {
    return { outcome: "done", message: `今天已领取（累计 ${task.claimedCount}/${task.maxClaims}），明天 0 点重置` }
  }
  if (task.limitReached) {
    return { outcome: "ineligible", message: `领取名额已用尽（${task.claimedCount}/${task.maxClaims}）` }
  }

  if (!task.claimable) {
    let text = String(options?.checkinText || "").trim() || pickText()
    if ([...text].length < MIN_LEN) text = pickText()
    if ([...text].length > MAX_LEN) text = [...text].slice(0, MAX_LEN).join("")
    await publishNote(cookie, { text, signature: signature || "magpie", color: "yellow", anonymous: false })
  }

  const res = await claimBenefit(cookie, taskId)
  if (res.already) return { outcome: "done", message: "今天已经领过了" }
  return {
    outcome: "claimed",
    credit: res.reward,
    message: `已领取 ${res.reward.toLocaleString("zh-CN")} Token（累计 ${(res.dashboard?.benefits?.tasks || []).find((t) => t.id === taskId)?.claimedCount ?? task.claimedCount + 1}/${task.maxClaims}）`,
  }
}
