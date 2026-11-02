// src/tasks.mjs —— 每日任务执行器（「只在能换到奖励时才动手」）
//
// 这个文件存在的唯一理由：**不要浪费 Token，也不要在墙上刷屏。**
//
// 站点把每日奖励拆成 4 个任务（`/api/model-service` 的 `benefits.tasks`），每个都有
// 自己的状态位。执行前必须按这些位逐个判断，只有「还没完成、还没领取、名额还在」
// 的那一条才值得动手：
//
//   claimed: true                 → 今天已经领过，跳过（再发也不会多给）
//   completed: true && claimable  → 内容已经在了，**只领不重做**
//   completed: true && !claimable → 内容在审核/不满足，跳过（重做是白花 Token）
//   !quotaAvailable || limitReached → 名额用尽，跳过
//   !enabled                      → 活动关着，跳过
//
// 只有最后一档（`!completed && !claimed && quotaAvailable`）才会真的发布内容。
// 而「发布内容」默认用内置文案（不消耗模型 Token）；要交给模型写，在选项里开 useModel。

import {
  claimBenefit,
  createPost,
  createProject,
  createRequirement,
  deleteContent,
  fetchDashboard,
  fetchMe,
  publishNote,
  uploadImage,
} from "./api.mjs"
import { CHECKIN_CIRCLE, PROJECT_LINK } from "./context.mjs"
import { COVER_BASE64, COVER_FILENAME, COVER_MIME } from "./cover.mjs"
import { pickNote, pickPost, pickProject } from "./texts.mjs"

/** 站点 4 个每日任务的中文名与「要不要先实名」 */
const TASK_META = {
  message_wall: { label: "寄语墙", needsRealname: false },
  plaza_post: { label: "搭子广场发帖", needsRealname: false },
  project_publish: { label: "资源中心项目", needsRealname: false },
  requirement_publish: { label: "需求中心", needsRealname: true },
}

const ALL_TASKS = Object.keys(TASK_META)

/** 同一个账号同时只允许跑一轮（登录回调和签到钩子可能撞在一起） */
const running = new Map()

/**
 * 给一条任务分类：这一轮该做什么。
 *
 * 返回 "done" | "claim" | "do" | "skip"。
 */
export function gateTask(task) {
  if (!task || typeof task !== "object") return "skip"
  if (task.claimed === true) return "done"
  if (task.enabled === false) return "skip"
  if (task.limitReached === true) return "skip"
  if (task.quotaAvailable === false) return "skip"
  if (task.completed === true) return task.claimable === true ? "claim" : "skip"
  return "do"
}

/**
 * 跑一轮每日任务。
 *
 * @param {object} p
 * @param {string} p.cookie
 * @param {object} [p.options]
 * @param {boolean} [p.options.useModel]    用模型写内容（默认 false：内置文案，0 Token）
 * @param {string[]} [p.options.tasks]      只做这几条（默认全部）
 * @param {boolean} [p.options.keepPublished] 领取后保留模板内容（默认 false = 删掉）
 * @param {string} [p.signature]            寄语署名
 * @param {string} [p.accountKey]           并发锁的键
 * @param {(msg:string)=>void} [p.log]
 * @returns {Promise<{results:Array, reward:number, message:string}>}
 */
export async function runDailyTasks({ cookie, options = {}, signature = "", accountKey = "default", log = () => {} }) {
  if (running.has(accountKey)) return running.get(accountKey)

  const job = (async () => {
    const dashboard = await fetchDashboard(cookie)
    const tasks = Array.isArray(dashboard?.benefits?.tasks) ? dashboard.benefits.tasks : []
    if (!tasks.length) return { results: [], reward: 0, message: "站点没有返回每日任务" }

    const allowed = Array.isArray(options.tasks) && options.tasks.length ? new Set(options.tasks) : null
    const realname = await realnameStatus(cookie).catch(() => ({ ok: false, status: "unknown" }))

    const results = []
    let reward = 0

    for (const task of tasks) {
      const meta = TASK_META[task.id] || { label: task.id, needsRealname: false }
      if (allowed && !allowed.has(task.id)) {
        results.push({ id: task.id, label: meta.label, status: "disabled-by-option" })
        continue
      }

      const action = gateTask(task)
      if (action === "skip") {
        results.push({ id: task.id, label: meta.label, status: "skip", reason: skipReason(task) })
        continue
      }
      if (action === "done") {
        results.push({ id: task.id, label: meta.label, status: "done" })
        continue
      }

      if (action === "claim") {
        const claimed = await tryClaim(cookie, task, log)
        if (claimed.ok) reward += claimed.reward
        results.push({ id: task.id, label: meta.label, status: claimed.ok ? "claimed" : "claim-failed", reward: claimed.reward })
        continue
      }

      // ── action === "do" ────────────────────────────────────────────
      if (meta.needsRealname && !realname.ok) {
        // 实名没通过就别发请求（省一次 400，也省建模内容）
        results.push({ id: task.id, label: meta.label, status: "skip", reason: `需要实名认证（当前：${realname.status}）` })
        continue
      }

      let published = null
      try {
        published = await performTask(cookie, task, { options, signature, log })
      } catch (error) {
        if (error?.skip === "realname_required") {
          // 站点回 400「请先完成实名认证」：这一条今天不做，也不重试 —— 重试只会再撞一次
          results.push({ id: task.id, label: meta.label, status: "skip", reason: "需要实名认证" })
          continue
        }
        if (error?.signIn === "expired") throw error
        results.push({ id: task.id, label: meta.label, status: "failed", reason: String(error?.message ?? error).slice(0, 200) })
        continue
      }

      const claimed = await tryClaim(cookie, task, log)
      if (claimed.ok) reward += claimed.reward

      // 模板内容不留在站上：领到奖励之后删掉（帖子 / 项目 / 需求）。
      // 寄语（note）例外 —— 它是「签到」本身，删掉会让卡片上的当日进度回退，
      // 而且一条 30 字的寄语本来就是正常社区内容。
      let cleaned = false
      if (claimed.ok && published?.id && published.type !== "note" && !options.keepPublished) {
        cleaned = await cleanup(cookie, published, log)
      }

      results.push({
        id: task.id,
        label: meta.label,
        status: claimed.ok ? "claimed" : "published-not-claimable",
        reward: claimed.reward,
        ...(published?.id ? { publishedId: published.id } : {}),
        ...(claimed.ok ? { cleaned } : {}),
      })
    }

    const claimedCount = results.filter((r) => r.status === "claimed").length
    const message = claimedCount
      ? `完成 ${claimedCount} 个任务，共 +${reward.toLocaleString("zh-CN")} Token`
      : summarizeSkip(results)

    return { results, reward, message }
  })()

  running.set(accountKey, job)
  try {
    return await job
  } finally {
    running.delete(accountKey)
  }
}

/** 这一条为什么跳过 —— 给人看的一句话 */
function skipReason(task) {
  if (task.limitReached) return `名额已用尽（${task.claimedCount}/${task.maxClaims}）`
  if (task.quotaAvailable === false) return "当前没有可用名额"
  if (task.enabled === false) return "活动未开启"
  if (task.completed && !task.claimable) return "内容已提交，等待站点结算"
  return "不满足参与条件"
}

function summarizeSkip(results) {
  const done = results.filter((r) => r.status === "done").length
  const skipped = results.filter((r) => r.status === "skip" || r.status === "disabled-by-option").length
  if (done && !skipped) return "今天的任务都领过了"
  if (skipped && !done) return "今天没有可做的任务"
  return `已领 ${done}，跳过 ${skipped}`
}

async function realnameStatus(cookie) {
  const me = await fetchMe(cookie)
  const status = me?.verification?.identity?.status
  const verified = me?.realnameVerified === true || status === "approved"
  return { ok: verified, status: status || (verified ? "approved" : "未提交") }
}

/** 领完奖励再删内容：顺序不能反 —— 先删会让任务变成「未完成」，就领不到了 */
async function cleanup(cookie, created, log) {
  try {
    await deleteContent(cookie, created)
    log(`已清理模板${labelOf(created.type)}：${created.id}`)
    return true
  } catch (error) {
    log(`清理模板${labelOf(created.type)}失败：${error?.message ?? error}`)
    return false
  }
}

function labelOf(type) {
  return { post: "帖子", project: "项目", demand: "需求", note: "寄语" }[type] || type
}

async function tryClaim(cookie, task, log) {
  try {
    const res = await claimBenefit(cookie, task.id)
    if (res.already) return { ok: true, reward: 0 }
    log(`已领取 ${task.id}：+${res.reward}`)
    return { ok: true, reward: res.reward }
  } catch (error) {
    log(`领取 ${task.id} 失败：${error?.message ?? error}`)
    return { ok: false, reward: 0 }
  }
}

/** 真正去发布内容（只有 gateTask 判成 "do" 才会走到这里） */
async function performTask(cookie, task, { options, signature, log }) {
  switch (task.id) {
    case "message_wall": {
      const text = pickNote()
      const note = await publishNote(cookie, { text, signature: signature || "magpie", color: "yellow", anonymous: false })
      log("已发布寄语")
      return { type: "note", id: note?.id }
    }
    case "plaza_post": {
      const draft = pickPost()
      const post = await createPost(cookie, { circleId: CHECKIN_CIRCLE, title: draft.title, content: draft.content })
      log("已发布搭子广场帖子")
      return { type: "post", id: post?.id }
    }
    case "project_publish": {
      const draft = pickProject()
      const cover = await uploadImage(cookie, {
        buffer: Buffer.from(COVER_BASE64, "base64"),
        filename: COVER_FILENAME,
        mime: COVER_MIME,
      })
      const created = await createProject(cookie, {
        title: draft.title,
        summary: draft.summary,
        content: draft.content,
        tags: draft.tags,
        link: options?.projectLink || PROJECT_LINK,
        cover,
      })
      log("已发布资源中心项目")
      return { type: "project", id: created?.id }
    }
    case "requirement_publish": {
      const requirement = await createRequirement(cookie, {
        title: "找一位 Node.js 项目搭子",
        summary:
          "独立开发者，正在做一个每日任务自动化的开源小工具，想找熟悉 Node.js 与前端的朋友一起把核心功能做稳，再考虑发布。",
        tags: ["Node.js", "自动化"],
      })
      log("已发布需求")
      return { type: "demand", id: requirement?.id }
    }
    default:
      return null
  }
}

export const _internal = { TASK_META, ALL_TASKS, skipReason }
