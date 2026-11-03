// src/default-browser.mjs —— 从「默认浏览器」里直接读登录态（不开窗、不弹窗）
//
// ═══════════════════════════════════════════════════════════════════
// 这条登录路解决什么
// ═══════════════════════════════════════════════════════════════════
//
// 用户日常浏览器里**已经登录过** opc.fiime.cn 时，再开一个隔离窗口登录一次是重复劳动。
// 这条路的动作是：找到默认浏览器 → 读它的 Cookies 库 → 解出 ANASID / opc_sid。
// 全程不启动浏览器、不碰网络、不改浏览器里的任何东西（只读，而且读的是副本）。
//
// 与「浏览器登录（隔离窗口）」的区别：
//   隔离窗口 = 干净的 profile，用户重新登录一次，登录态只留在插件手里
//   这条     = 复用用户日常浏览器的登录态，一次点击就完成
//
// ═══════════════════════════════════════════════════════════════════
// 为什么不是「直接读文件」那么简单（三条边界）
// ═══════════════════════════════════════════════════════════════════
//
// ① **Cookies 是 SQLite，而且被浏览器锁着**。直接打开会拿到「database is locked」，
//    所以一律先复制到临时目录再读（复制完立刻删）。
// ② **值是用 DPAPI 包起来的 AES 密钥加密的**（Windows）：
//    `Local State` 的 `os_crypt.encrypted_key` = base64("DPAPI" + DPAPI(32 字节 key))。
//    Node / bun 都没有内置 DPAPI，只能借 PowerShell 解一次（见 `dpapiUnprotect`）。
// ③ **Chrome 127+ 有 app-bound 加密（v20 前缀）**：那把 key 绑定在浏览器进程上，
//    外部解不开。遇到 v20 必须**明确报错**，让用户改用隔离窗口，而不是假装"没登录"。
//
// 只读、不可写：本模块对用户浏览器目录只做 copyFileSync，不写、不改、不删。

import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { createDecipheriv } from "node:crypto"

/**
 * Chromium 内核浏览器的 User Data 目录（按平台）。
 *
 * 三个平台各写一份：macOS 的 Chrome 目录**不带** `User Data` 这一层，
 * Linux 的 browser 目录名又是 `google-chrome` 这种 —— 不要用 Windows 的拼法套。
 */
const USER_DATA_DIRS = Object.freeze({
  win32: {
    edge: ["Microsoft", "Edge", "User Data"],
    chrome: ["Google", "Chrome", "User Data"],
    brave: ["BraveSoftware", "Brave-Browser", "User Data"],
    vivaldi: ["Vivaldi", "User Data"],
    operagx: ["Opera Software", "Opera GX Stable"],
    opera: ["Opera Software", "Opera Stable"],
    chromium: ["Chromium", "User Data"],
  },
  darwin: {
    edge: ["Microsoft Edge"],
    chrome: ["Google", "Chrome"],
    brave: ["BraveSoftware", "Brave-Browser"],
    vivaldi: ["Vivaldi"],
    chromium: ["Chromium"],
  },
  linux: {
    chrome: ["google-chrome"],
    edge: ["microsoft-edge"],
    chromium: ["chromium"],
    brave: ["BraveSoftware", "Brave-Browser"],
  },
})

/** Windows 默认浏览器的 ProgId → 我们的键 */
const PROG_IDS = Object.freeze({
  MSEdgeHTM: "edge",
  MSEdgeDHTML: "edge",
  ChromeHTML: "chrome",
  BraveHTML: "brave",
  VivaldiHTM: "vivaldi",
  OperaStable: "opera",
  ChromiumHTM: "chromium",
})

/** 这些 profile 目录不算（缓存 / 系统） */
const NOT_PROFILE = /^(System Profile|Guest Profile|Crashpad|ShaderCache|GrShaderCache|GraphiteDawnCache|BrowserMetrics|component_crx_cache|extensions_crx_cache|Snapshots|SetupMetrics)$/i

/** 解密前的前缀：v10 / v11 / v12 是老的 AES-GCM；v20 是 app-bound（解不开） */
const PREFIX_GCM = ["v10", "v11", "v12"]

/**
 * 默认浏览器是谁（Windows 注册表 → ProgId）。
 * 读不到就返回空串，调用方退回「按顺序找已安装的 Chromium」。
 */
export function defaultBrowserKey({ exec = execFileSync } = {}) {
  if (process.platform !== "win32") return ""
  try {
    const out = exec(
      "reg.exe",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice", "/v", "ProgId"],
      { encoding: "utf8", windowsHide: true },
    )
    const m = /ProgId\s+REG_SZ\s+(\S+)/i.exec(out)
    const prog = m ? m[1].trim() : ""
    if (PROG_IDS[prog]) return PROG_IDS[prog]
    const low = prog.toLowerCase()
    if (low.includes("edge")) return "edge"
    if (low.includes("chrome")) return "chrome"
    if (low.includes("brave")) return "brave"
    if (low.includes("360")) return "360"
    if (low.includes("qq")) return "qq"
    return ""
  } catch {
    return ""
  }
}

/** 各平台的「应用数据根目录」 */
function appDataRoot() {
  if (process.platform === "win32") return process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support")
  return join(homedir(), ".config")
}

/** 某个浏览器的 User Data 目录（不存在返回空串） */
export function userDataDir(key) {
  const platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux"
  const parts = USER_DATA_DIRS[platform]?.[key]
  if (!parts) return ""
  const dir = join(appDataRoot(), ...parts)
  return existsSync(dir) ? dir : ""
}

/** 探测到的 Chromium 浏览器列表（默认浏览器优先，其余按常见程度） */
export function browserCandidates({ exec = execFileSync } = {}) {
  const first = defaultBrowserKey({ exec })
  const platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux"
  const all = Object.keys(USER_DATA_DIRS[platform] || {})
  const order = first ? [first, ...all.filter((k) => k !== first)] : all
  const out = []
  for (const key of order) {
    const dir = userDataDir(key)
    if (dir) out.push({ key, dir })
  }
  return out
}

/** 一个 User Data 目录下所有 profile 的子目录名（Default / Profile 1 / Profile 2 …） */
export function profilesOf(userData) {
  let entries = []
  try {
    entries = readdirSync(userData, { withFileTypes: true })
  } catch {
    return []
  }
  const names = entries.filter((e) => e.isDirectory() && !NOT_PROFILE.test(e.name)).map((e) => e.name)
  // Default 排前面：绝大多数用户只用它
  return names.sort((a, b) => (a === "Default" ? -1 : b === "Default" ? 1 : a.localeCompare(b)))
}

/** Cookies 库的位置（新版在 `Network/` 下，老版直接在 profile 根） */
export function cookiesFileOf(profileDir) {
  for (const rel of [["Network", "Cookies"], ["Cookies"]]) {
    const p = join(profileDir, ...rel)
    if (existsSync(p)) return p
  }
  return ""
}

/**
 * 用 DPAPI 解开 `Local State` 里的 `os_crypt.encrypted_key`。
 *
 * Node / bun 都没有内置 DPAPI，只能借一次 PowerShell（CurrentUser 作用域，只读）。
 * 测试时用 `exec` 注入假实现。
 *
 * @param {string} b64 base64（不含 "DPAPI" 前缀）
 * @returns {Buffer} 32 字节 AES key
 */
export function dpapiUnprotect(b64, { exec = execFileSync } = {}) {
  const safe = String(b64 || "").replace(/[^A-Za-z0-9+/=]/g, "")
  if (!safe) throw new Error("Local State 里没有 os_crypt.encrypted_key")
  const script =
    "$ErrorActionPreference='Stop';" +
    "Add-Type -AssemblyName System.Security;" +
    `$b=[Convert]::FromBase64String('${safe}');` +
    "$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);" +
    "[Convert]::ToBase64String($p)"
  const out = exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  })
  return Buffer.from(String(out).trim(), "base64")
}

/** 读 `Local State` 里的 AES key（DPAPI 解好）。读不到返回 null。 */
export function oscryptKey(userData, { exec } = {}) {
  try {
    const state = JSON.parse(readFileSync(join(userData, "Local State"), "utf8"))
    const enc = String(state?.os_crypt?.encrypted_key || "")
    if (!enc) return null
    // ⚠ 先 base64 **解码**再找 "DPAPI" 前缀 —— 那个前缀是字节，不是 base64 字符串的一部分。
    //   直接 enc.startsWith("DPAPI") 永远为假，会把整串（含前缀）交给 DPAPI →
    //   CryptographicException「参数无效」。
    const raw = Buffer.from(enc, "base64")
    const body = raw.subarray(0, 5).toString("latin1") === "DPAPI" ? raw.subarray(5) : raw
    return dpapiUnprotect(body.toString("base64"), { exec })
  } catch {
    return null
  }
}

/**
 * 解一条 cookie 的 `encrypted_value`。
 *
 * v10/v11/v12：AES-256-GCM，nonce 12 字节 + 密文 + tag 16 字节
 * v20：app-bound（Chrome 127+），**解不开** —— 抛出带 `appBound` 标记的错误
 * 没有前缀：老版本明文，原样返回
 */
export function decryptCookieValue(encrypted, key) {
  const buf = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted ?? [])
  if (!buf.length) return ""
  const prefix = buf.subarray(0, 3).toString("latin1")
  if (prefix === "v20") {
    throw Object.assign(new Error("这个浏览器的 Cookies 用了 app-bound 加密（Chrome 127+），外部解不开"), {
      appBound: true,
    })
  }
  if (!PREFIX_GCM.includes(prefix)) return buf.toString("utf8")
  if (!key || key.length !== 32) throw new Error("没有拿到 AES key，无法解密 Cookies")
  const payload = buf.subarray(3)
  const nonce = payload.subarray(0, 12)
  const tag = payload.subarray(payload.length - 16)
  const ct = payload.subarray(12, payload.length - 16)
  const d = createDecipheriv("aes-256-gcm", key, nonce)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8")
}

/**
 * 打开 SQLite（node:sqlite → bun:sqlite 兜底）。
 * 两个都没有就返回 null —— 调用方给「这条环境不支持」的明确错误。
 */
async function openSqlite(file) {
  try {
    const { DatabaseSync } = await import("node:sqlite")
    const db = new DatabaseSync(file, { readOnly: true })
    return { all: (sql) => db.prepare(sql).all(), close: () => db.close() }
  } catch {
    /* 不是 node，或者 node:sqlite 不可用 → 试 bun */
  }
  try {
    const { Database } = await import("bun:sqlite")
    const db = new Database(file, { readonly: true })
    return { all: (sql) => db.query(sql).all(), close: () => db.close() }
  } catch {
    return null
  }
}

/** Chrome 的 `expires_utc` 是「1601-01-01 起的微秒」；0 表示会话 cookie */
function expiresMs(expiresUtc) {
  const n = Number(expiresUtc) || 0
  if (n <= 0) return 0
  return Math.round(n / 1000 - 11644473600000)
}

/**
 * 从默认浏览器里读某个站点的 cookie。
 *
 * @param {string} host 例如 `opc.fiime.cn`（按后缀匹配 host_key）
 * @param {object} [o]
 * @param {Function} [o.exec]        测试注入：DPAPI / 注册表调用
 * @param {Function} [o.openDb]      测试注入：打开 SQLite
 * @param {number} [o.now]
 * @returns {Promise<{cookie:string, browser:string, profile:string, host:string, names:string[], appBound:boolean}>}
 */
export async function readDefaultBrowserCookies(host, { exec, openDb = openSqlite, now = Date.now() } = {}) {
  const bare = String(host || "").trim().replace(/^www\./, "")
  if (!bare) return { cookie: "", browser: "", profile: "", host: "", names: [], appBound: false }

  const errors = []
  for (const { key, dir } of browserCandidates({ exec })) {
    for (const profile of profilesOf(dir)) {
      const profileDir = join(dir, profile)
      const file = cookiesFileOf(profileDir)
      if (!file) continue

      // ① 复制一份：浏览器锁着数据库，直接读会 "database is locked"
      let tmp = ""
      try {
        tmp = mkdtempSync(join(tmpdir(), "magpie-cookies-"))
        const copy = join(tmp, "Cookies")
        copyFileSync(file, copy)

        const db = await openDb(copy)
        if (!db) {
          errors.push("当前运行时不支持 SQLite（需要 node:sqlite 或 bun:sqlite）")
          continue
        }
        // expires_utc 是 17 位整数（1601 起的微秒），超过 JS 安全整数 —— 必须 CAST 成文本，
        // 否则 node:sqlite 直接抛「Value is too large to be represented as a JavaScript number」
        let rows = []
        try {
          rows = db.all(
            `select host_key, name, value, encrypted_value, cast(expires_utc as text) as expires_utc from cookies where host_key like '%${bare.replace(/'/g, "''")}'`,
          )
        } finally {
          try {
            db.close()
          } catch {
            /* ignore */
          }
        }
        if (!rows.length) continue

        // ② 解密：只有真的需要时才去读 Local State / 调 DPAPI
        const key32 = rows.some((r) => r.value === "" || r.value === null) ? oscryptKey(dir, { exec }) : null
        const jar = []
        const encryptedNames = []
        let appBound = false
        for (const r of rows) {
          const exp = expiresMs(r.expires_utc)
          if (exp && exp < now) continue
          let value = r.value
          if (!value) {
            try {
              value = decryptCookieValue(Buffer.from(r.encrypted_value ?? []), key32)
            } catch (error) {
              if (error?.appBound) appBound = true
              encryptedNames.push(String(r.name || ""))
              errors.push(String(error?.message || error))
              value = ""
            }
          }
          if (value) jar.push(`${r.name}=${value}`)
        }
        if (!jar.length) {
          // 一条都解不开时，把「哪些名字解不开」带回去 —— 调用方据此区分
          // 「没登录过这个站」和「登录过但加密解不开」，两者给用户的建议完全不同。
          if (appBound) {
            return { cookie: "", browser: key, profile, host: bare, names: [], appBound: true, encryptedNames }
          }
          continue
        }
        return {
          cookie: jar.join("; "),
          browser: key,
          profile,
          host: bare,
          names: jar.map((c) => c.split("=")[0]),
          encryptedNames,
          appBound,
        }
      } catch (error) {
        errors.push(String(error?.message || error))
      } finally {
        if (tmp) {
          try {
            rmSync(tmp, { recursive: true, force: true })
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  return { cookie: "", browser: "", profile: "", host: bare, names: [], encryptedNames: [], appBound: false, errors }
}

export const _internal = { USER_DATA_DIRS, PROG_IDS, PREFIX_GCM }
