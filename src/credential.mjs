// src/credential.mjs —— 「用户到底给了我什么？」+「这个账号现在能干什么？」
//
// magpie 落下来的凭据只有两种形状：
//
//   API Key（`opc_sk_…`）       打模型面 /api/model-service/v1（Bearer），**查不了额度**
//   网页 Cookie（`ANASID=…`）   打网页面 /api/*（Cookie + CSRF），**打不了模型面**
//
// ⚠ 两条都要，缺一条就有一半功能是空的。所以 cookie 登录时，插件会用 cookie
//   自动创建/复用一个 API Key（key 本身只在创建时回一次 secret，必须落盘，见 store）。
//
// ⚠ 凭据种类只认三处（AGENTS 坑 30）：运行时识别过的缓存 → metadata.kind → 形状。

import { createHash } from "node:crypto"
import { join } from "node:path"

import { createApiKey, fetchDashboard, keysOf } from "./api.mjs"
import { readJson, writeJson, fileOf } from "./store.mjs"

/** magpie 的 auth 对象里，凭据可能落在 `access`（oauth）或 `key`（api）上 */
export function rawCredentialOf(auth) {
  if (!auth) return ""
  const value = auth.access || auth.key || auth.token || ""
  return String(value || "").trim()
}

/** 凭据的稳定指纹 —— 只用来区分账号，不参与鉴权 */
export function fingerprint(raw) {
  return createHash("sha256").update(String(raw || "")).digest("hex").slice(0, 12)
}

/**
 * 按「长相」给一个初判（不发请求）。
 * 返回 "key" | "cookie" | "unknown"。
 */
export function shapeKind(raw) {
  const v = String(raw || "").trim()
  if (/^opc_sk_[A-Za-z0-9]{8,}$/.test(v)) return "key"
  if (/(?:^|;\s*)(?:ANASID|ANACCOUNT|opc_sid|server_session_)/.test(v)) return "cookie"
  if (v.includes("=") && v.includes(";")) return "cookie"
  if (v.startsWith("opc_sk_")) return "key"
  return "unknown"
}

/** 把这个账号的 key 缓存文件路径（文件名带账号，见 AGENTS 坑 16） */
function keyFile(account) {
  return fileOf("session", { siteId: "opc", account: account.uid || fingerprint(account.raw) })
}

/**
 * 解析一条凭据能做什么。**不做网络请求** —— 需要联网的部分在 ensureModelKey。
 */
export function resolveAccount(auth, options = {}) {
  const raw = rawCredentialOf(auth) || String(options.cookie || "").trim()
  const meta = auth?.metadata && typeof auth.metadata === "object" ? auth.metadata : {}
  const kind = meta.kind || shapeKind(raw)
  const cookie = kind === "cookie" ? raw : String(meta.cookie || "")
  const apiKey = kind === "key" ? raw : String(meta.apiKey || "")

  return {
    kind,
    raw,
    cookie,
    apiKey,
    uid: String(meta.userId || auth?.uid || (raw ? fingerprint(raw) : "")),
    name: String(meta.nickname || meta.username || auth?.accountId || ""),
  }
}

/**
 * 确保这个账号有一把能用的 API Key。
 *
 * 顺序：metadata 里带的 → 本地缓存里的 → 用 cookie 新建一把。
 * 只有 cookie 才能新建；只有 key 的账号直接返回空，让调用方说明还差什么。
 *
 * @returns {Promise<{apiKey:string, keyId:string, created:boolean}>}
 */
export async function ensureModelKey(account, { options, force = false } = {}) {
  if (account.apiKey) return { apiKey: account.apiKey, keyId: "", created: false }
  if (!account.cookie) return { apiKey: "", keyId: "", created: false }

  const file = keyFile(account)
  if (!force) {
    const cached = readJson(file, null)
    if (cached?.apiKey) return { apiKey: String(cached.apiKey), keyId: String(cached.keyId || ""), created: false }
  }

  const dashboard = await fetchDashboard(account.cookie)
  const existing = keysOf(dashboard).filter((k) => k && k.status === "active")

  // 站点不会把 secret 再回给我们，所以哪怕已有 key 也只能新建一把。
  // 名字带上日期，用户在站点「模型服务 → 密钥」里能一眼看出是插件建的。
  const name = `${options?.keyName || "magpie-opc-auth"}`.slice(0, 32)
  const created = await createApiKey(account.cookie, existing.length ? `${name}-${existing.length + 1}` : name)

  writeJson(file, { apiKey: created.secret, keyId: created.id, name, at: Date.now() })
  return { apiKey: created.secret, keyId: created.id, created: true }
}

/** 这个账号有没有可用的模型通道（不需要联网） */
export function hasModelKey(account) {
  return Boolean(account?.apiKey)
}
