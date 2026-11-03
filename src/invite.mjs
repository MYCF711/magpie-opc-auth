// src/invite.mjs —— 邀请码：**双模式，由一个 magpie 开关决定**（0.1.3 起）
//
// ═══════════════════════════════════════════════════════════════════
// 为什么不是「登录页填一个码」
// ═══════════════════════════════════════════════════════════════════
//
// 0.1.2 用的是「登录方式里先问邀请码」的写法（`ask()` 串多步问答）。0.1.3 改成
// magpie 自己的插件选项 —— 供应商编辑器 →「插件选项」里的一个 Off/On 开关：
//
//   开关关（默认）  自动 —— 跟随「最后一个注册成功的新号」自己的码；
//                         一个都没有时，用内置的默认码（作者的码）
//   开关开          首选 —— 挂到 magpie 账号页「首选」那个账号名下
//
// 只有这两种模式，**没有第三种**。magpie 的插件选项值只存布尔
// （`settings.PluginOptions map[string]map[string]bool`，设置接口
// `POST /api/settings/plugin-option` 的入参也只有 `{provider, key, on}`），
// 装不下字符串，也装不下「从 N 项里选一个」—— 想「指定任意码」只能改
// `inviteCode` 选项（plugins.json 里的 JSON 配置）或内置的 `DEFAULT_INVITE`。
//
// 开关本身不是这个文件画的：它是 magpie 的 `auth.options`，插件通过
// `input.magpie.option(provider, key)` 读，**每次读都是当前值**，拨一下立刻生效。
//
// ═══════════════════════════════════════════════════════════════════
// 本站的特殊性
// ═══════════════════════════════════════════════════════════════════
//
// FiimeOPC 的邀请码**只在注册 URL 上生效**（`/register?invite=<code>`）：
// 老账号在登录 URL 上带码没有任何效果（实测），事后也补不了。
// 所以「用谁的码」这个决定必须发生在**打开注册页之前**——本模块只回答这一个问题，
// 不碰浏览器、不碰网络。
//
// 文件（都在 `~/.cache/magpie/`，全可删）：
//   opc-invite-codes.json       每账号自己的码（uid → {code, accountId}），首选模式用
//   opc-invite-registered.json  最后一个注册成功的新号的码，自动模式用
//   opc-invite.json             0.1.2 的旧策略文件，只当自动模式的兜底
//
// ⚠ 「自动」不能跟「最后一个登录 / 签到的号」—— 重登旧号、或者签到轮到一个旧号，
//   下一次注册就会挂到旧号名下。所以只有**注册成功那一刻**才写 registered。

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** 开关 key —— 与 index.mjs 声明 `auth.options` 时用的那个必须是同一个 */
export const INVITE_FIRST_OPTION = "invite-first"

function cacheDir() {
  return join(homedir(), ".cache", "magpie")
}

function readJson(file, fallback) {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"))
    return v ?? fallback
  } catch {
    return fallback
  }
}

/** 原子写；失败不抛（cache 写坏不能影响登录） */
function writeJson(file, value) {
  try {
    mkdirSync(cacheDir(), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(value, null, 1), "utf8")
    renameSync(tmp, file)
  } catch {
    /* 规矩 ③：这里的东西全都可删 */
  }
}

/**
 * 0.1.2 的旧策略文件：`~/.cache/magpie/<prefix>-invite.json`。
 * 现在只当自动模式的兜底（用户当时手动填过的码），不再表达「模式」。
 */
export function createInviteStore(prefix) {
  const file = join(cacheDir(), `${prefix}-invite.json`)

  /** 当前要用的码（可能空串）。 */
  function read() {
    const v = readJson(file, null)
    return typeof v?.code === "string" ? v.code.trim() : ""
  }

  function write(code, { source = "" } = {}) {
    const c = String(code ?? "").trim()
    if (!c) return
    const prev = readJson(file, null) ?? {}
    writeJson(file, { ...prev, code: c, source: String(source || ""), at: Date.now() })
  }

  return { file, read, write }
}

/**
 * 每个账号自己的邀请码：`uid → {code, accountId, at}`。
 *
 * 首选模式要用「首选那个账号的码」，而 prompts / authorize 是同步的，等不了网络，
 * 所以码必须在别处（usage / 登录成功）顺手记下来。
 */
export function createInviteCodes(prefix) {
  const file = join(cacheDir(), `${prefix}-invite-codes.json`)

  function readAll() {
    const v = readJson(file, {})
    return v && typeof v === "object" && !Array.isArray(v) ? v : {}
  }

  function get(uid) {
    const key = String(uid ?? "").trim()
    if (!key) return null
    const v = readAll()[key]
    const code = typeof v?.code === "string" ? v.code.trim() : ""
    return code ? { code, accountId: String(v.accountId || ""), at: Number(v.at) || 0 } : null
  }

  function note(uid, { code, accountId = "" } = {}) {
    const key = String(uid ?? "").trim()
    const c = String(code ?? "").trim().toUpperCase()
    if (!key || !c) return null
    const all = readAll()
    if (all[key]?.code === c && all[key]?.accountId === accountId) return all[key]
    const entry = { code: c, accountId: String(accountId || ""), at: Date.now() }
    all[key] = entry
    writeJson(file, all)
    return entry
  }

  return { file, readAll, get, note }
}

/** 最后一个注册成功的新号的码：`{code, accountId, at}` 或 null */
export function createRegisteredInvite(prefix) {
  const file = join(cacheDir(), `${prefix}-invite-registered.json`)

  function read() {
    const v = readJson(file, null)
    const code = typeof v?.code === "string" ? v.code.trim().toUpperCase() : ""
    if (!code) return null
    return { code, accountId: String(v.accountId || ""), at: Number(v.at) || 0 }
  }

  /** ⚠ 只在「注册成功」那一刻调用；普通登录不许调（会退回「跟随最后一个登录」） */
  function note({ code, accountId = "" } = {}) {
    const c = String(code ?? "").trim().toUpperCase()
    if (!c) return null
    const entry = { code: c, accountId: String(accountId || ""), at: Date.now() }
    writeJson(file, entry)
    return entry
  }

  return { file, read, note }
}

/**
 * magpie 账号页「首选」那个账号的键（`logins.json` 的 `home`，通常就是 provider id）。
 *
 * 判定顺序照 magpie 自己的：`first: true` → 最小正 `order` → 第一条。
 * 读不到就返回空串 —— 首选模式会回落到自动。
 */
export function preferredHome(provider, { loginsFile, authFile } = {}) {
  const logins = readJson(loginsFile || join(homedir(), ".config", "magpie", "logins.json"), [])
  if (!Array.isArray(logins)) return ""
  const rows = logins.filter((l) => l && l.agent === `plugin:${provider}` && l.home)
  if (!rows.length) return ""
  const pick =
    rows.find((l) => l.first === true) ||
    rows.filter((l) => Number(l.order) > 0).sort((a, b) => Number(a.order) - Number(b.order))[0] ||
    rows[0]
  const home = String(pick?.home || "").trim()
  if (!home) return ""
  const auth = readJson(authFile || join(homedir(), ".config", "magpie", "plugin-auth.json"), {})
  // 首选账号存在，但它可能以 `provider#1` 这类键挂在 auth 里 —— 以 magpie 的键为准
  return home
}

/** 首选账号在 `plugin-auth.json` 里的那个条目（没有就是 null） */
export function preferredAccount(provider, { loginsFile, authFile } = {}) {
  const home = preferredHome(provider, { loginsFile, authFile })
  if (!home) return null
  const auth = readJson(authFile || join(homedir(), ".config", "magpie", "plugin-auth.json"), {})
  const e = auth?.[home]
  if (!e || typeof e !== "object") return null
  return {
    home,
    uid: String(e.uid || e.org || "").trim(),
    accountId: String(e.accountId || "").trim(),
  }
}

/**
 * 这次注册该带谁的码 —— **纯函数**，只回答一个问题，方便单独锁。
 *
 * 开关开（首选）：首选账号的码 → 自动链
 * 开关关（自动）：最后注册的新号的码 → 0.1.2 手填过的 → 内置默认码
 *
 * @returns {{code:string, source:"preferred"|"registered"|"rolling"|"default"}}
 */
export function resolveInviteCode({ firstOn = false, preferred = null, codes = {}, registered = null, rolling = "", fallback = "" } = {}) {
  // 本站的码是 8 位大写字母数字：无论从哪一份缓存读出来，出这一层前统一归一化。
  // （手写进 `opc-invite-codes.json` 的值可能是小写，不归一化会让 endsWith 断言和
  //  注册页上的实际参数对不上。）
  const up = (v) => String(v ?? "").trim().toUpperCase()
  if (firstOn && preferred) {
    const hit = codes?.[preferred.uid]
    const code = up(hit?.code)
    if (code) return { code, source: "preferred" }
  }
  if (registered?.code) return { code: up(registered.code), source: "registered" }
  const r = up(rolling)
  if (r) return { code: r, source: "rolling" }
  return { code: up(fallback), source: "default" }
}

/** 登录页那句「本次邀请上级」：和实际用的码同源，不各写一份判断 */
export function inviteNote({ code, source, preferred } = {}) {
  if (!code) return "本次不带邀请码（打开普通注册页）"
  if (source === "preferred") return `本次邀请上级：${preferred?.accountId || preferred?.uid || "首选账号"}（${code}）`
  if (source === "registered") return `本次邀请上级：上一个注册成功的新号（${code}）`
  if (source === "rolling") return `本次邀请上级：上次用过的码（${code}）`
  return `本次邀请上级：内置默认码（${code}）`
}
