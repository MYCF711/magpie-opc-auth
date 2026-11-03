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
export async function webFetch(path, { cookie, method = "GET", body, csrf, timeout = TIMEOUT, signal, extraHeaders = {} } = {}) {
  const headers = webHeaders(cookie, { ...(csrf ? { [CSRF_HEADER]: csrf } : {}), ...extraHeaders })
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

/**
 * 我的邀请码 + 邀请统计（只读）。
 *
 * 站点形状（实测 2026-11-03，`GET /api/invite`，Cookie 鉴权）：
 *
 *   { "code": "ELJQK8Q8",
 *     "url": "https://opc.fiime.cn/register?invite=ELJQK8Q8",
 *     "uses": 0, "invitedCount": 0, "paidCount": 0,
 *     "tokenRewardCount": 0, "tokenRewardTotal": 0 }
 *
 * `url` 是完整的邀请注册链接 —— 邀请码**只影响注册**，登录时带不生效。
 * 「重新生成邀请码」是网页端的写操作（30 天一次），插件不替用户做。
 */
export async function fetchInvite(cookie) {
  const res = await webFetch("/api/invite", { cookie })
  if (isLoginBroken(res.status, res.data)) {
    throw Object.assign(new Error("读取邀请码时登录已失效"), {
      signIn: "expired",
      status: 401,
      code: "sign_in_required",
    })
  }
  if (res.status !== 200) {
    throw Object.assign(new Error(`读取邀请码失败（HTTP ${res.status}）：${shortText(res.data)}`), {
      status: res.status,
      code: "upstream_error",
    })
  }
  const d = res.data || {}
  return {
    code: String(d.code || ""),
    url: String(d.url || ""),
    uses: Number(d.uses) || 0,
    invitedCount: Number(d.invitedCount) || 0,
    paidCount: Number(d.paidCount) || 0,
    tokenRewardCount: Number(d.tokenRewardCount) || 0,
    tokenRewardTotal: Number(d.tokenRewardTotal) || 0,
  }
}

/** 邀请注册链接：优先用站点给的 `url`，没有就按实测形状拼 */
export function inviteRegisterUrl(code, url = "") {
  const u = String(url ?? "").trim()
  if (u) return u
  const c = String(code ?? "").trim()
  return c ? `${WEB_BASE}/register?invite=${encodeURIComponent(c)}` : `${WEB_BASE}/zh-cn/register`
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

/** HTML 转义：站点的帖子正文是「纯文本 + 富文本」两个字段 */
function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

/**
 * 上传图片（multipart）。项目任务要用 —— 站点强制要求至少一张预览图。
 * @returns {Promise<string>} 站点上的图片路径，例如 `/uploads/plaza/img_xxx.webp`
 */
export async function uploadImage(cookie, { buffer, filename = "cover.png", mime = "image/png" }) {
  const fd = new FormData()
  fd.append("file", new Blob([buffer], { type: mime }), filename)
  const res = await fetch(`${WEB_BASE}/api/plaza/upload`, {
    method: "POST",
    headers: {
      "user-agent": USER_AGENT,
      cookie,
      origin: WEB_BASE,
      referer: `${WEB_BASE}/zh-cn/projects/new`,
    },
    body: fd,
    signal: abortSignal(undefined, 60_000),
  })
  const text = await res.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  if (!res.ok) throw new Error(`上传图片失败（HTTP ${res.status}）：${shortText(data)}`)
  const url = (data?.urls || [])[0]
  if (!url) throw new Error("上传图片成功但没有返回地址")
  return url
}

/** 搭子广场发帖（打卡签到圈） */
export async function createPost(cookie, { circleId, title, content }) {
  const csrf = await fetchCsrf(cookie)
  const res = await webFetch("/api/community/posts", {
    method: "POST",
    cookie,
    csrf,
    extraHeaders: { referer: `${WEB_BASE}/zh-cn/community` },
    body: {
      circleId,
      topicIds: [],
      customTopics: [],
      title,
      content,
      contentHtml: `<p>${escapeHtml(content)}</p>`,
      mood: "",
      postMode: "post",
      images: [],
      intents: [],
      skills: [],
      applicationsEnabled: false,
    },
  })
  if (isLoginBroken(res.status, res.data)) {
    throw Object.assign(new Error("发帖时登录已失效"), { signIn: "expired", status: 401 })
  }
  if (res.status !== 200) throw new Error(`发帖失败（HTTP ${res.status}）：${shortText(res.data)}`)
  return res.data?.post || null
}

/** 资源中心发表项目 */
export async function createProject(cookie, { title, summary, content, tags = [], link, cover }) {
  const csrf = await fetchCsrf(cookie)
  const res = await webFetch("/api/projects", {
    method: "POST",
    cookie,
    csrf,
    extraHeaders: { referer: `${WEB_BASE}/zh-cn/projects/new` },
    body: {
      title,
      summary,
      content,
      tags,
      link,
      images: [cover],
      cover, // ⚠ 只给 images 会被拒：「主图必选」，必须带 cover
      intents: [],
      applicationsEnabled: false,
      roles: [],
    },
  })
  if (isLoginBroken(res.status, res.data)) {
    throw Object.assign(new Error("发布项目时登录已失效"), { signIn: "expired", status: 401 })
  }
  if (res.status !== 200) {
    throw new Error(`发布项目失败（HTTP ${res.status}）：${shortText(res.data)}`)
  }
  return res.data?.project || null
}

/** 需求中心：发布一条合作需求（需要实名认证） */
export async function createRequirement(cookie, { title, summary, tags = [] }) {
  const csrf = await fetchCsrf(cookie)
  const res = await webFetch("/api/requirements", {
    method: "POST",
    cookie,
    csrf,
    extraHeaders: { referer: `${WEB_BASE}/zh-cn/requirements` },
    body: {
      companyName: "独立开发者",
      demandType: "project",
      title,
      summary,
      budget: "面议",
      duration: "1-2 个月",
      acceptMode: "subcontract",
      contact: "",
      deadline: 0,
      tags,
      images: [],
    },
  })
  if (isLoginBroken(res.status, res.data)) {
    throw Object.assign(new Error("发布需求时登录已失效"), { signIn: "expired", status: 401 })
  }
  if (res.status === 400 && /实名/.test(JSON.stringify(res.data))) {
    // ⚠ 这里不用 `.code`：那是给宿主看的错误码，必须在 ERROR-CODES 词表内
    //   （scripts/check-error-codes.mjs 会拦）。「需要实名」是插件内部的跳过原因，
    //   放在 `.skip` 上，由 src/tasks.mjs 决定这一条今天不做。
    throw Object.assign(new Error("需要先完成实名认证"), { skip: "realname_required" })
  }
  if (res.status !== 200) {
    throw new Error(`发布需求失败（HTTP ${res.status}）：${shortText(res.data)}`)
  }
  return res.data?.requirement || res.data || null
}

/** 删除一条已发布的内容（帖子 / 项目 / 需求 / 寄语） */
export async function deleteContent(cookie, { type, id }) {
  const paths = {
    post: `/api/community/posts/${encodeURIComponent(id)}`,
    project: `/api/projects/${encodeURIComponent(id)}`,
    demand: `/api/requirements/${encodeURIComponent(id)}`,
    note: `/api/message-wall/${encodeURIComponent(id)}`,
  }
  const path = paths[type]
  if (!path) throw new Error(`不知道 ${type} 该怎么删`)
  const csrf = await fetchCsrf(cookie)
  const res = await webFetch(path, { method: "DELETE", cookie, csrf })
  if (res.status === 200) return true
  // 404 = 已经没了，对调用方来说是同一个结果
  if (res.status === 404) return true
  throw new Error(`删除${type}失败（HTTP ${res.status}）：${shortText(res.data)}`)
}

function shortText(value) {
  if (typeof value === "string") return value.slice(0, 200)
  try {
    return JSON.stringify(value).slice(0, 200)
  } catch {
    return String(value).slice(0, 200)
  }
}
