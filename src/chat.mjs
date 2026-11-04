// src/chat.mjs —— 请求接管（auth.loader）
//
// FiimeOPC 的模型面就是标准 OpenAI Chat：给定 baseURL + Bearer key 即可，
// 不需要改 body、不需要剥字段、不需要折叠 SSE（上游本来就支持流式）。
// 所以这个 loader 只做四件事：
//   ① 认凭据  ② 确保有一把 key  ③ 把 baseURL + apiKey 交给宿主
//   ④ **包装 fetch**：上游拿网页当回复时，当场翻译成一条带 status + code 的错误
//
// 为什么要 ④：本站对「不认识的模型」回的是 `404 + 站点 SPA 的 HTML 落地页`，
// 不包装的话宿主只能说「a web page, not an API reply」，用户看到一串营销页标题，
// 完全看不出是「模型被下线了」还是「cookie 过期了」。

import { BASE, PROVIDER, USER_AGENT } from "./context.mjs"
import { ensureModelKey, fingerprint, resolveAccount } from "./credential.mjs"
import { errorResponse, htmlTitle, looksLikeHtml } from "./http.mjs"
import { readSnapshot } from "./store.mjs"

/** 目录里查不到时给用户的操作指引 —— 三处错误文案共用一句，别各写各的 */
const PICK_MODEL_HINT = "到 opc.fiime.cn/zh-cn/model-service →「接入模型」挑一个当前在线的模型名"

/**
 * 从请求体里取出 `model`。宿主传进来的是 JSON 字符串（非 UTF-8 时是 bytes）。
 * 取不到就返回空串 —— 错误文案会退化成「不知道是哪个模型」，不编造。
 */
export function modelOfBody(body) {
  try {
    if (typeof body === "string") return String(JSON.parse(body)?.model ?? "")
    if (body instanceof Uint8Array) return String(JSON.parse(new TextDecoder().decode(body))?.model ?? "")
    if (body instanceof ArrayBuffer) return String(JSON.parse(new TextDecoder().decode(new Uint8Array(body)))?.model ?? "")
    if (body && typeof body === "object" && !ArrayBuffer.isView(body) && "model" in body) {
      return String(body.model ?? "")
    }
  } catch {
    /* 不是 JSON（比如 multipart 上传）—— 没有 model 就空着 */
  }
  return ""
}

/**
 * 上游目录里的模型 id 集合。来源是 `~/.cache/magpie/plugin-store-snapshot-opc.json`
 * （provider.models 钩子每次成功拉目录就刷新它）。
 *
 * ⚠ 空集合 ≠ 模型都不存在：没拉过目录时它一定是空的，所以调用方**只在集合非空时**
 *   才敢把 404 判成「这个模型被下线了」。
 */
export function catalogIds(siteId = PROVIDER) {
  const snapshot = readSnapshot(siteId)
  const list = Array.isArray(snapshot?.models) ? snapshot.models : []
  const ids = new Set()
  for (const item of list) {
    const id = typeof item === "string" ? item : String(item?.id ?? "")
    if (id) ids.add(id)
  }
  return ids
}

/**
 * 把「上游回的是网页」翻译成宿主看得懂的错误。
 *
 * 三种真相，判错就会把用户送去干错事：
 *   401/403 → 登录态没了，要人重新登录（别让宿主去换号）
 *   404     → 这个模型上游不认了（只搁置这个模型，不打死账号）
 *   其他    → 地址/网关不对（默认桶，别标账号）
 */
export function pageReplyError({ status, text = "", model = "", baseURL = BASE }) {
  const code = Number(status) || 0
  const title = htmlTitle(text)
  const suffix = title ? `（上游返回的网页标题：${title}）` : "（上游返回的是 HTML，不是 JSON / SSE）"

  if (code === 401 || code === 403) {
    return errorResponse(
      `需要重新登录 FiimeOPC：模型面把网页当回复返回了，HTTP ${code}${suffix}。` +
        "在 magpie 里重新登录一次 opc（浏览器登录，或到「模型服务 → 密钥」建一把 key 再粘贴）。",
      401,
      "sign_in_required",
    )
  }

  if (code === 404) {
    const which = model ? `「${model}」` : "这个模型"
    return errorResponse(
      `上游没有${which}：站点已经把它从模型目录里下线了，所以这个地址回到了网页 404 而不是 API${suffix}。` +
        `${PICK_MODEL_HINT}，再用现成的模型名重试（当前目录里还有 deepseek-v4-pro / deepseek-v4-flash / opc-txt-v1 等）。`,
      404,
      "model_not_found",
    )
  }

  return errorResponse(
    `上游返回的是网页而不是 API 回复（HTTP ${code || "未知"}${suffix}，请求地址 ${baseURL}）。` +
      "这通常意味着模型面地址变了或被拦了 —— 到 opc.fiime.cn/zh-cn/model-service 看「快速开始」里的接入地址。",
    502,
    "upstream_error",
  )
}

/**
 * 聊天通道的 fetch 包装。
 *
 * **只拦「content-type 是网页」的响应**：JSON / SSE / 空 body 一律原样交回宿主
 * （坑 8：在 fetch 里读流会把流式输出弄断）。网页才读 body —— 读完本来就要替换掉。
 *
 * @param {object} [o]
 * @param {Set<string>|(() => Set<string>)} [o.catalog]  上游目录（判断「下线」用）
 * @param {(model:string)=>void} [o.onModelGone]         确认下线时的落盘回调
 */
export function createChatFetch({ baseURL = BASE, catalog, onModelGone } = {}) {
  const idsOf = () => {
    try {
      const value = typeof catalog === "function" ? catalog() : catalog
      if (value instanceof Set) return value
      if (Array.isArray(value)) return new Set(value)
    } catch {
      /* 读目录失败当「不知道」 */
    }
    return new Set()
  }

  return async function chatFetch(input, init = {}) {
    const headers = new Headers(init?.headers || {})
    // 上游按 UA 认客户端：缺 UA / 产品名形态会被回 403 TM.00000001（AGENTS 坑 32）
    headers.set("user-agent", USER_AGENT)

    const response = await fetch(input, { ...init, headers })
    const contentType = String(response.headers.get("content-type") || "").toLowerCase()
    // 不是网页 → 一个字节都不动（流式靠这条活着）
    if (!contentType.includes("text/html")) return response

    let text = ""
    try {
      text = await response.text()
    } catch {
      return response // 读不出来就原样交回，至少宿主还能说「回复异常」
    }

    const model = modelOfBody(init?.body)
    const known = idsOf()
    // 只有「目录拉过（非空）」且「目录里没有它」才敢确认下线
    if (Number(response.status) === 404 && model && known.size > 0 && !known.has(model)) {
      try {
        onModelGone?.(model)
      } catch {
        /* 标记写不进去不影响这次报错 */
      }
    }

    return pageReplyError({ status: response.status, text, model, baseURL })
  }
}

/**
 * @param {object} p
 * @param {() => Promise<object>} p.getAuth
 * @param {object} p.options
 * @param {(accountKey:string, model:string)=>void} [p.recordRetired] 记下「这个模型没了」
 * @returns {Promise<{baseURL?:string, apiKey?:string, headers?:object, fetch?:Function}>}
 */
export async function buildLoaderResult({ getAuth, options, recordRetired } = {}) {
  const auth = await getAuth()
  const account = resolveAccount(auth, options)
  if (!account.raw) return {}

  let apiKey = account.apiKey
  if (!apiKey && account.cookie) {
    // 只有 cookie：用它在站点上换一把 key（第一次会创建，之后走本地缓存）
    const ensured = await ensureModelKey(account, { options })
    apiKey = ensured.apiKey
  }

  if (!apiKey) {
    const error = new Error(
      "这条账号只有网页 Cookie，而且换 API Key 失败了 —— " +
        "到 opc.fiime.cn/zh-cn/model-service 的「创建 API Key」手动建一把，再用「粘贴 API Key」登录一次。",
    )
    error.status = 401
    error.code = "sign_in_required"
    throw error
  }

  const accountKey = account.uid || fingerprint(account.raw)

  return {
    baseURL: BASE,
    apiKey,
    headers: {
      "user-agent": USER_AGENT,
      "x-magpie-plugin": "magpie-opc-auth",
    },
    // 上游回网页时不下传（见文件头 ④）
    fetch: createChatFetch({
      baseURL: BASE,
      catalog: () => catalogIds(PROVIDER),
      onModelGone: (model) => recordRetired?.(accountKey, model),
    }),
  }
}
