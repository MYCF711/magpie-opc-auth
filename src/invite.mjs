// src/invite.mjs —— 邀请码的通用做法（本站：邀请码只在**注册**时生效）
//
// ═══════════════════════════════════════════════════════════════════
// 为什么需要这个模块
// ═══════════════════════════════════════════════════════════════════
//
// 邀请码必须出现在「注册那一刻」的 URL 上（`…/register?invite=<CODE>`），
// 事后补不了；而 magpie 的登录方式是一个**静态 prompts 数组**，天生没法表达
// 「先问邀请码，再接着问主登录的问题」。
//
// 解法是 `ask()` —— 每次返回**下一个**问题，问完返回 `null`（HOOKS 四·陷阱 5）：
//
//   ask({})            → 邀请码
//   ask({ invite })    → null（主登录没有额外问题）
//   authorize({ invite }) → 保存策略，**直接调用主登录的 authorize**
//
// ⚠ 本站与 magicrew / accio 那类「登录 URL 上带 ic=…」的厂商不同：
//   FiimeOPC 的码走 `https://opc.fiime.cn/register?invite=<CODE>`，**只影响注册**；
//   登录时带不生效（实测 `/zh-cn/login?invite=…` 没有任何邀请效果）。
//   所以这里的主方法是「邀请码注册（隔离窗口）→ 自动登录」，码拼进注册页 URL。
//
// ═══════════════════════════════════════════════════════════════════
// 语义（用户只需记两个数字）
// ═══════════════════════════════════════════════════════════════════
//
//   0 / 留空 / 非法文本 → 自动（沿用当前策略里的码）
//   1                  → 保持当前（与 0 等价；留 1 是为了「我知道有当前值」的显式表达）
//   其它                → 当作新码
//
// 「自动」的码从哪来：本站能查「自己的邀请码」（登录后 `GET /api/invite`），
// 登录成功时把拿到的码写回策略（滚动）；查不到就只能靠用户首次填一次。
// ⇒ 两种都支持：`policy.source` 记 'used'（滚动来的）/ 'chosen'（手填的）。

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

function cacheDir() {
  return join(homedir(), ".cache", "magpie")
}

/**
 * 策略存储：`~/.cache/magpie/<prefix>-invite.json`。
 * 只写 cache，不碰 `~/.config/magpie`（那是 magpie 的目录，见 store.mjs 规矩 ①）。
 *
 * @param {string} prefix 插件短名，如 "opc" / "accio"。**必须带**，否则两个插件会抢同一个文件。
 */
export function createInviteStore(prefix) {
  const file = join(cacheDir(), `${prefix}-invite.json`)

  function readPolicy() {
    try {
      const v = JSON.parse(readFileSync(file, "utf8"))
      return v && typeof v === "object" ? v : null
    } catch {
      return null
    }
  }

  /** 当前要用的码（可能空串）。 */
  function read() {
    const v = readPolicy()
    return typeof v?.code === "string" ? v.code.trim() : ""
  }

  /** 与码配对的其他字段（如 Accio 的 `sId`）—— 厂商链接里有几对参数就存几个。 */
  function readExtra(key) {
    const v = readPolicy()
    return typeof v?.[key] === "string" ? v[key].trim() : ""
  }

  /**
   * 写策略。`extra` 是「与这个码绑定的其它参数」。
   *
   * ⚠ 换码时必须一起换 `extra`：拿旧参数配新码是最典型的「填了码但邀请不生效」。
   */
  function write(code, { source = "", extra = {} } = {}) {
    const c = String(code ?? "").trim()
    if (!c) return
    const prev = readPolicy()
    const next = { code: c, source: String(source ?? ""), at: Date.now() }
    const extraKeys = new Set([...Object.keys(prev ?? {}), ...Object.keys(extra ?? {})])
    for (const k of extraKeys) {
      if (k === "code" || k === "source" || k === "at") continue
      const s = String(extra?.[k] ?? "").trim()
      if (s) next[k] = s
      else if (prev && prev.code === c && prev[k]) next[k] = prev[k]
    }
    try {
      mkdirSync(cacheDir(), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(next, null, 1), "utf8")
      renameSync(tmp, file)
    } catch {
      // cache 写失败不影响登录（规矩 ③：这里的东西全都可删）
    }
  }

  return { file, read, readExtra, write }
}

/** 「不带邀请码」的哨兵：输入 `-` / `none` 时存它，主登录据此打开普通注册页。 */
export const INVITE_NONE = "-"

/** 文本框的灰色字：每次点开按当前策略现算（magpie 的 prompts 没有复合控件）。 */
export function inviteHint(current) {
  const c = String(current ?? "").trim()
  if (c === INVITE_NONE) return "当前：不带邀请码 · 输入 1 保持不变，或直接填码"
  return c
    ? `当前默认码：${c} · 输入 1 保持不变，或直接填新码；输入 - 不带邀请码`
    : "填「邀请人」的码（注册后你会挂在他名下）；留空 = 默认码，输入 - 不带邀请码"
}

/**
 * 把用户输入归一成「要用的码」：
 *
 *   `-` / `none` → 哨兵（不带邀请码，打开普通注册页）
 *   空 / `0` / `1` → 沿用当前（没有当前时就是默认邀请码）
 *   其它 → 当作新码（去空格、转大写 —— 本站的码是 8 位大写字母数字）
 */
export function pickInvite(raw, current) {
  const s = String(raw ?? "").trim()
  if (s === INVITE_NONE || s.toLowerCase() === "none") return INVITE_NONE
  return resolveInvite(s, current).trim().toUpperCase()
}

/** 数字语义：0 / 空 / 1 → 沿用当前；其它 → 新码（原样，具体厂商可再处理）。 */
export function resolveInvite(raw, current) {
  const s = String(raw ?? "").trim()
  if (s === "" || s === "0" || s === "1") return String(current ?? "").trim()
  return s
}

/**
 * 生成「邀请码注册 → 自动登录」的登录方式。
 *
 * @param {object} o
 * @param {string} o.label        面板上显示的名字
 * @param {object} o.mainMethod   主登录方式（必须实现 authorize）
 * @param {object[]} [o.followUps] 主登录要问的问题（邀请码问完之后依次问）
 * @param {(inputs:object)=>string} o.pick  从 inputs 里取用户填的邀请码
 * @param {(code:string)=>void} o.save      保存策略（通常是 store.write）
 * @param {(inputs:object)=>object} [o.beforeAuthorize] 可选：调主登录前做点事
 * @param {()=>string} [o.current] 当前策略里的码（只用来写提示文字）
 */
export function makeInviteMethod({ label, mainMethod, followUps = [], pick, save, beforeAuthorize, current }) {
  const inviteKey = "invite"

  /** 这个 key 问过没有 —— 用 hasOwnProperty，因为「填了空字符串」也算问过 */
  const has = (inputs, key) =>
    !!inputs && typeof inputs === "object" && Object.prototype.hasOwnProperty.call(inputs, key)

  const hint = () => {
    try {
      return inviteHint(String(current?.() ?? ""))
    } catch {
      return inviteHint("")
    }
  }

  return {
    type: "oauth",
    label,
    // 面板列表里要能显示「第一个问题」，否则一条没有任何 prompts 的方式看起来像坏掉了
    get prompts() {
      return [invitePrompt()]
    },
    async ask(inputs) {
      // 第一个问题
      if (!has(inputs, inviteKey)) return invitePrompt()
      // 之后是主登录的问题，按顺序问
      for (const p of followUps) {
        if (!has(inputs, p.key)) return p
      }
      return null
    },
    async authorize(inputs) {
      const code = pick(inputs ?? {})
      if (code) save(code)
      if (typeof beforeAuthorize === "function") await beforeAuthorize(inputs ?? {}, code)
      // ⚠ 直接复用主登录的 authorize —— 邀请码不是一个独立流程，
      //   它是「主登录的一个前置问题」。复制一份 callback 必然有一天只改一边。
      return await mainMethod.authorize(inputs ?? {})
    },
  }

  function invitePrompt() {
    return { type: "text", key: inviteKey, message: "邀请码（可选）", placeholder: hint() }
  }
}
