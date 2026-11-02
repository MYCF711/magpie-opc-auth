// src/api.mjs —— 打 FiimeOPC 的那一层
//
// 两个面，两套鉴权，别混：
//   网页面  opc.fiime.cn/api/...        Cookie（ANASID + opc_sid） + X-CSRF-Token
//   模型面  opc.fiime.cn/api/model-service/v1/...  Authorization: Bearer opc_sk_…
//
// 实测（2026-11-03，真实账号）：
//   · 网页 cookie 打 /v1/models → {"error":{"type":"invalid_api_key"}} —— 模型面只认 Bearer
//   · API Key 打 /api/model-service（网页面）→ 401 —— 额度只认网页 cookie
//   所以「一次登录两条都齐」的唯一做法是：cookie 登录后由插件创建/复用一把 key（见 credential.mjs）。
//
// 所有请求必须带 User-Agent：站点对缺失 UA 的请求回「请求异常，请稍后再试」（requireCaptcha）。

import { BASE, USER_AGENT, WEB_BASE, CSRF_HEADER } from "./context.mjs"
import { abortSignal, isLoginBroken } from "./http.mjs"

export const TIMEOUT = 20_000
export const MODEL_TIMEOUT = 120_000

/** 网页面的公共头 */
function webHeaders(cookie, extra = {}) {
  return {
    "user-agent": USER_AGENT,
    accept: "application/json",
    "accept-language": "zh-CN,zh;q=0.9",
    "cache-control": "no-cache",
    cookie: cookie || "",
    origin: WEB_BASE,
    referer: `${WEB_BASE}/zh-cn/model-service`,
    ...extra,
  }
}

/** 打一次网页面接口 */
export async function webFetch(path, { cookie, method = "GET", body, csrf, timeout = TIMEOUT, signal } = {}) {
  const headers = webHeaders(cookie, csrf ? { [CSRF_HEADER]: csrf } : {})
  if (body !== undefined) headers["content-type"] = "application/json"

  const res = await fetch(WEB_BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: abortSignal(signal, timeout),
  })
  const text = await res.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  return { status: res.status, data, headers: res.headers, text }
}

/** 取 CSRF token（网页面的写操作都要带） */
export async function fetchCsrf(cookie) {
  const res = await webFetch("/api/csrf-token", { cookie })
  const token = res.data?.token || ""
  if (!token) throw new Error(`取 CSRF token 失败（HTTP ${res.status}）`)
  return token
}

/** 当前账号（名字、OPC ID、等级、认证状态） */
export async function fetchMe(cookie) {
  const res = await webFetch("/api/auth/me", { cookie })
  if (isLoginBroken(res.status, res.data)) {
    throw Object.assign(new Error("FiimeOPC 登录已失效（cookie 过期），请重新登录"), {
      signIn: "expired",
      status: 401,
      code: "sign_in_required",
    })
  }
  if (res.status !== 200) throw new Error(`读取账号信息失败（HTTP ${res.status}）`)
  const user = res.data?.user || res.data || {}
  return user
}

/** 账户面板：余额、今日用量、任务、已有 key */
export async function fetchDashboard(cookie) {
  const res = await webFetch("/api/model-service", { cookie })
  if (isLoginBroken(res.status, res.data)) {
    throw Object.assign(new Error("FiimeOPC 登录已失效（cookie 过期），请重新登录"), {
      signIn: "expired",
      status: 401,
      code: "sign_in_required",
    })
  }
  if (res.status !== 200) {
    throw Object.assign(new Error(`读取额度失败（HTTP ${res.status}）：${shortText(res.data)}`), {
      status: res.status,
      code: "upstream_error",
    })
  }
  return res.data
}

/** 已有密钥列表（dashboard.keys 是权威来源，这里不另开接口） */
export function keysOf(dashboard) {
  return Array.isArray(dashboard?.keys) ? dashboard.keys : []
}

/** 创建一把 API Key —— 返回 { id, secret }，secret 只在创建时出现一次 */
export async function createApiKey(cookie, name) {
  const csrf = await fetchCsrf(cookie)
  const res = await webFetch("/api/model-service/keys", {
    cookie,
    method: "POST",
    csrf,
    body: { name },
  })
  if (isLoginBroken(res.status, res.data)) {
    throw Object.assign(new Error("创建 API Key 时登录已失效"), { signIn: "expired", status: 401 })
  }
  if (res.status !== 200) {
    throw Object.assign(
      new Error(`创建 API Key 失败（HTTP ${res.status}）：${shortText(res.data)}`),
      { status: res.status, code: "invalid_request" },
    )
  }
  const secret = res.data?.secret || res.data?.key?.secret || ""
  const id = res.data?.key?.id || ""
  if (!secret) throw new Error("创建 API Key 成功但响应里没有 secret")
  return { id, secret }
}

/** 删除一把 API Key（不用于登录流程，留给用户手动清理） */
export async function deleteApiKey(cookie, id) {
  const csrf = await fetchCsrf(cookie)
  return webFetch(`/api/model-service/keys/${encodeURIComponent(id)}`, {
    cookie,
    method: "DELETE",
    csrf,
  })
}

/** 模型目录 —— 只认 Bearer API Key */
export async function fetchModelList(apiKey, { signal } = {}) {
  const res = await fetch(`${BASE}/models`, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    signal: abortSignal(signal, TIMEOUT),
  })
  const text = await res.text()
  if (!res.ok) {
    const err = new Error(`读取模型目录失败（HTTP ${res.status}）：${text.slice(0, 200)}`)
    if (res.status === 401) {
      err.signIn = "expired"
      err.status = 401
      err.code = "sign_in_required"
    }
    throw err
  }
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error("模型目录返回的不是 JSON")
  }
  const list = Array.isArray(data?.data) ? data.data : []
  return list
}

/** 领取某个每日任务的奖励 */
export async function claimBenefit(cookie, task) {
  const csrf = await fetchCsrf(cookie)
  const res = await webFetch("/api/model-service/benefits/claim", {
    cookie,
    method: "POST",
    csrf,
    body: { task },
  })
  if (res.status === 409) return { already: true, reward: 0, dashboard: null }
  if (isLoginBroken(res.status, res.data)) {
    throw Object.assign(new Error("领取奖励时登录已失效"), { signIn: "expired", status: 401 })
  }
  if (res.status !== 200) {
    throw new Error(`领取失败（HTTP ${res.status}）：${shortText(res.data)}`)
  }
  return { already: false, reward: Number(res.data?.reward) || 0, dashboard: res.data?.dashboard || null }
}

/** 寄语墙：先让站点做内容审核，再发布 */
export async function publishNote(cookie, { text, signature, color = "yellow", anonymous = false }) {
  const csrf = await fetchCsrf(cookie)
  const base = { text, signature, color, anonymous }
  const check = await webFetch("/api/message-wall/check", {
    cookie,
    method: "POST",
    csrf,
    body: { ...base, requestId: randomId() },
  })
  if (check.status !== 200) {
    throw new Error(`寄语检查失败（HTTP ${check.status}）：${shortText(check.data)}`)
  }
  const status = check.data?.analysis?.status
  if (status !== "approved" && status !== "pending") {
    throw new Error(`寄语审核未通过：${check.data?.analysis?.reason || status}`)
  }
  const pub = await webFetch("/api/message-wall", {
    cookie,
    method: "POST",
    csrf: check.headers?.get?.("x-csrf-token") || csrf,
    body: { ...base, checkId: check.data.checkId },
  })
  if (pub.status !== 200) {
    throw new Error(`发布寄语失败（HTTP ${pub.status}）：${shortText(pub.data)}`)
  }
  return pub.data?.note || null
}

export function randomId() {
  try {
    return globalThis.crypto.randomUUID()
  } catch {
    return `r_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
  }
}

function shortText(value) {
  if (typeof value === "string") return value.slice(0, 200)
  try {
    return JSON.stringify(value).slice(0, 200)
  } catch {
    return String(value).slice(0, 200)
  }
}
