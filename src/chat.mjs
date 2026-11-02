// src/chat.mjs —— 请求接管（auth.loader）
//
// FiimeOPC 的模型面就是标准 OpenAI Chat：给定 baseURL + Bearer key 即可，
// 不需要改 body、不需要剥字段、不需要折叠 SSE（上游本来就支持流式）。
// 所以这个 loader 只做三件事：认凭据 → 确保有一把 key → 把通道交给宿主。

import { BASE, USER_AGENT } from "./context.mjs"
import { ensureModelKey, resolveAccount } from "./credential.mjs"

/**
 * @param {object} p
 * @param {() => Promise<object>} p.getAuth
 * @param {object} p.options
 * @returns {Promise<{baseURL?:string, apiKey?:string, headers?:object}>}
 */
export async function buildLoaderResult({ getAuth, options }) {
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

  return {
    baseURL: BASE,
    apiKey,
    headers: {
      "user-agent": USER_AGENT,
      "x-magpie-plugin": "magpie-opc-auth",
    },
  }
}
