// src/web-login.mjs —— 隔离浏览器登录（第三种登录方式，也是最省事的一种）
//
// 为什么要有这条：
//   「粘贴 Cookie」要求用户开 F12、在 Application → Cookies 里翻出 ANASID / opc_sid，
//   对不熟 DevTools 的人是道坎；而且粘错一个字就是一条「登录失效」。
//   这条登录路只让用户在**插件开的一次性浏览器窗口**里正常登录一次，
//   插件从 CDP 读走 Cookie —— 不碰用户日常浏览器的任何数据，窗口关掉临时 profile 就没了。
//
// 为什么是「隔离」的：
//   user-data-dir 是 mkdtemp 出来的空目录（见 browser-login.mjs），
//   里面没有扩展、没有书签、没有历史、也没有用户其他网站的登录态。
//   用户在这个窗口里登录的东西，除 opc.fiime.cn 的 cookie 之外什么都不留下；
//   收工后整个目录 `rm -rf`。
//
// 与「粘贴 Cookie」的关系：两条路得到的凭据形状完全一样（都是 `ANASID=…; opc_sid=…`），
// 所以后续的额度、模型通道、签到走的是同一套代码，不存在「登录方式不同行为不同」的分叉。

import { fetchMe } from "./api.mjs"
import { chromiumLogin, findBrowser } from "./browser-login.mjs"
import { WEB_BASE } from "./context.mjs"

/** 登录页（站点 SPA，路径来自前端路由表） */
export const LOGIN_URL = `${WEB_BASE}/zh-cn/login`

/**
 * 必须拿到的 cookie。
 *
 * 实测（2026-11-03，真实账号）：
 *   · 只带 `ANASID` + `opc_sid` 就能打通 `/api/model-service` 与 `/api/auth/me`（都是 200）
 *   · `ANACCOUNT` 是 365 天的账号标识，有更好，没有也不影响接口
 * 所以这里只要求这两个 —— 少要求一个就少一种「窗口里明明登录了却说没抓到」的误判。
 */
export const REQUIRED_COOKIES = ["ANASID", "opc_sid"]

/** 会话 cookie 的有效期（`opc_sid` 7 天、`ANASID` 会话级；服务端不滑动续期） */
export const LOGIN_TIMEOUT_MS = 5 * 60_000

/**
 * 开一个隔离浏览器窗口，等用户登录，然后收下 Cookie。
 *
 * @param {object} [o]
 * @param {string} [o.url]
 * @param {number} [o.timeoutMs]
 * @param {AbortSignal} [o.signal]
 * @param {{name:string,path:string}} [o.browser] 测试时注入
 * @param {() => ({name:string,path:string}|null)} [o.find] 测试时注入「找浏览器」
 * @returns {Promise<{type:"success", key:string, metadata:object} | {type:"failed", error:string}>}
 */
export async function loginViaBrowser({
  url = LOGIN_URL,
  timeoutMs = LOGIN_TIMEOUT_MS,
  signal,
  browser,
  find = findBrowser,
  /** `{userData, profile}`：把真实浏览器的登录态带进一次性 profile（「读取默认浏览器凭证」用） */
} = {}) {
  const target = browser ?? find()
  if (!target) {
    return {
      type: "failed",
      error:
        "没找到 Chromium 内核浏览器（Chrome / Edge / 360 / QQ / Brave 任意一个都行）。" +
        "装一个再试，或者改用「粘贴 API Key」（只跑模型）。",
    }
  }

  let result
  try {
    result = await chromiumLogin({
      browser: target,
      url,
      cookieNames: REQUIRED_COOKIES,
      timeoutMs,
      signal,
    })
  } catch (error) {
    return {
      type: "failed",
      error: `受控浏览器登录没走完：${String(error?.message || error).slice(0, 300)}`,
    }
  }

  const cookie = String(result?.cookie || "").trim()
  if (!cookie) {
    return {
      type: "failed",
      error: "窗口关得太早，没抓到登录 Cookie。重试一次，登录成功后别关窗口，等它自己收工。",
    }
  }

  // 顺手问一次账号名：卡片标题会用 accountId，否则 magpie 只能显示
  // 「API key ...5bf2」这种尾号（用户会以为自己登的是 API Key）。
  // 查不到就留空 —— 不能因为这一步失败就判登录失败。
  let accountId = ""
  let uid = ""
  try {
    const me = await fetchMe(cookie)
    accountId = String(me?.username || me?.nickname || "")
    uid = String(me?.id || me?.opcId || "")
  } catch {
    /* 名字不是登录的必要条件 */
  }

  return {
    type: "success",
    key: cookie,
    ...(accountId ? { accountId } : {}),
    ...(uid ? { uid } : {}),
    metadata: {
      kind: "cookie",
      source: "browser",
      browser: result.browser || target.name,
      loggedInAt: Date.now(),
      ...(accountId ? { username: accountId } : {}),
      ...(uid ? { userId: uid } : {}),
    },
  }
}
