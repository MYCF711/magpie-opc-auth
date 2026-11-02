// magpie-opc-auth —— FiimeOPC（一人公司社区）的供应商插件
//
// 这个文件**只做装配**：九个钩子各挂一个实现，实现全在 src/。
// 想改某个钩子的行为，去改 src/ 里对应的那个文件，不要在这里加逻辑。
//
// ─────────────────────────────────────────────────────────────────────
// 九项清单
// ─────────────────────────────────────────────────────────────────────
//   ① config(cfg)                       声明 provider + 静态模型表
//   ② auth.methods[]                    登录（粘贴 Cookie / 粘贴 API Key）
//   ③ auth.refresh(auth)                续期（粘贴型凭据没有 refresh，不续期）
//   ④ auth.loader(getAuth)              请求接管（OpenAI Chat 直连）
//   ⑤ auth.usage(getAuth)               额度 → 卡片（余额 / 今日用量 / 任务进度）
//   ⑥ auth.checkin(getAuth)             签到（寄语墙任务）
//   ⑦ provider.models(provider,{auth})  每账号目录（/v1/models）
//   ⑧ "chat.headers"(input, output)     每请求加头
//
//   ⑨ accountId / uid / icon / maxConcurrency —— 数据字段，决定卡片长什么样
//
// ─────────────────────────────────────────────────────────────────────
// 三条铁律
// ─────────────────────────────────────────────────────────────────────
//   1. config.models 必须有内容 —— 未登录也要有，否则显示 "0 models"
//   2. authorize() 立刻返回 —— 真正等登录的是 callback()（本插件没有 authorize，
//      粘贴型凭据由宿主直接保存，识别放在 loader / usage 里做）
//   3. refresh 返回的是合并 —— 本插件没有可续期的凭据，所以直接不返回
//
// ─────────────────────────────────────────────────────────────────────
// 这个网站的两条硬事实（读完再改代码）
// ─────────────────────────────────────────────────────────────────────
//   · 模型面（/api/model-service/v1/*）**只认 Bearer API Key**（opc_sk_…），
//     网页 cookie 打过去是 invalid_api_key
//   · 网页面（/api/model-service、/api/auth/me、签到）**只认 cookie**，
//     API Key 打过去是 401
//   · 所以「一次登录两条都齐」= 用 cookie 登录，再由插件用 cookie 建一把 key
//     （POST /api/model-service/keys），secret 落盘到 ~/.cache/magpie/

import {
  BASE,
  ICON,
  MODEL_SPECS,
  PLUGIN_VERSION,
  PROVIDER,
  PROVIDER_NAME,
  SDK,
  WEB_BASE,
} from "./src/context.mjs"
import { createUsageCache } from "./src/usage-cache.mjs"
import { fetchDashboard, fetchMe, fetchModelList } from "./src/api.mjs"
import {
  ensureModelKey,
  fingerprint,
  hasModelKey,
  rawCredentialOf,
  resolveAccount,
} from "./src/credential.mjs"
import { buildLoaderResult } from "./src/chat.mjs"
import { buildModels, staticModels } from "./src/models.mjs"
import { buildUsage } from "./src/usage.mjs"
import { doCheckin } from "./src/checkin.mjs"
import { loginViaBrowser } from "./src/web-login.mjs"
import { runDailyTasks } from "./src/tasks.mjs"
import { normaliseOptions } from "./src/options.mjs"

/**
 * 登录成功后的后台动作：建 API Key + 跑今天的每日任务。
 *
 * ⚠ 故意不 await：登录结果要立刻还给用户（铁律 2 的延伸），
 *   而「建 key」和「发一条寄语」都是秒级网络动作，让它们在后台跑完就行。
 *   失败不抛 —— 用户下次刷新卡片会看到具体缺什么。
 */
async function afterLogin(cookie, options) {
  const account = { cookie, apiKey: "", uid: fingerprint(cookie) }
  try {
    await ensureModelKey(account, { options })
  } catch {
    /* 建 key 失败不阻塞登录 */
  }
  try {
    await runDailyTasks({ cookie, options, signature: "", accountKey: account.uid })
  } catch {
    /* 任务失败留给卡片显示 */
  }
}

export const OpcAuthPlugin = async (_ctx, rawOptions) => {
  const options = normaliseOptions(rawOptions)

  // 额度卡片会被频繁刷新：成功 60 秒、失败 5 秒，同 key 并发合并。
  const usageCache = createUsageCache({ ttlMs: 60_000, failTtlMs: 5_000 })

  return {
    // ═══ ① 声明 provider ══════════════════════════════════════════════
    config: async (cfg) => {
      cfg.provider ??= {}
      // ⚠ 用 ??= ，不要覆盖用户在 plugins.json 里配的
      cfg.provider[PROVIDER] ??= {
        name: PROVIDER_NAME,
        npm: SDK,
        api: BASE,
        models: staticModels(), // ⚠ 未登录时也必须有内容（铁律 1）
      }
    },

    auth: {
      provider: PROVIDER,

      // ⚠ 图标要写两份，缺一份就有地方显示灰方块：
      //   这里 auth.icon → 供应商列表那一行、用量概览的卡
      //   package.json 的 magpie.icon → 插件列表那一行、插件详情页左上角
      icon: ICON,
      maxConcurrency: 4,

      // ═══ ② 登录：两条粘贴路，运行时按形状识别 ═════════════════════
      //
      // ⚠ 这里**不加 authorize**：magpie 的 api 类型会把用户粘的值原样保存，
      //   「这是 cookie 还是 key」交给 src/credential.mjs 的 shapeKind() 在运行时认。
      //   粘错东西的后果是第一次请求报错，而不是登录界面出错 —— 这是我们想要的
      //   （登录界面里没有网络，能一秒返回）。
      methods: [
        // ── 方式一：隔离浏览器登录（推荐）────────────────────────────
        //
        // 插件开一个**一次性 profile** 的 Chromium 窗口：没有扩展、没有书签、
        // 也没有你在其他网站的登录态。你在窗口里正常登录 opc.fiime.cn，
        // 插件从 CDP 读走 ANASID + opc_sid，然后关窗、删目录。
        //
        // ⚠ authorize() 必须立刻返回（铁律 2）：这里只返回「窗口会开」这个事实，
        //   真正的等待在 callback() 里。
        {
          type: "oauth",
          label: "浏览器登录（隔离窗口，不碰你日常浏览器）",
          async authorize() {
            return {
              url: `${WEB_BASE}/zh-cn/login`,
              instructions:
                "插件会开一个隔离的浏览器窗口（一次性 profile，不读也不写你日常浏览器的数据）。" +
                "在窗口里登录 opc.fiime.cn，登录成功后**别关窗口**，等它自己收工 —— " +
                "它会自动收下登录态，一次就把额度、模型通道和签到都配好。",
              method: "auto",
              opened: true,
              async callback() {
                try {
                  const result = await loginViaBrowser({})
                  // 登录成功 → 后台把「API Key」和「今天的每日任务」一起收掉
                  if (result?.type === "success" && result.key) {
                    void afterLogin(result.key, options)
                  }
                  return result
                } catch (error) {
                  return { type: "failed", error: String(error?.message || error).slice(0, 400) }
                }
              },
            }
          },
        },
        {
          type: "api",
          label: "粘贴浏览器 Cookie（额度 + 模型通道 + 签到，一次齐）",
          placeholder: "ANASID=…; opc_sid=…; ANACCOUNT=…（浏览器 F12 → Application → Cookies 复制）",
        },
        {
          type: "api",
          label: "粘贴 API Key（只跑模型；额度仍需 Cookie）",
          placeholder: "opc_sk_…（opc.fiime.cn/zh-cn/model-service → 创建 API Key）",
        },
      ],

      // ═══ ③ 续期 ═══════════════════════════════════════════════════
      //
      // 粘贴型凭据没有 refresh_token；站点也不给续期权（cookie 7 天过期，
      // 服务端不滑动续期）。所以这里明确不续期 —— 过期后由用户重登。
      async refresh() {
        return undefined
      },

      // ═══ ④ 请求接管 ═══════════════════════════════════════════════
      async loader(getAuth) {
        return buildLoaderResult({ getAuth, options })
      },

      // ═══ ⑤ 额度 ═══════════════════════════════════════════════════
      async usage(getAuth) {
        const auth = await getAuth()
        const account = resolveAccount(auth, options)
        if (!account.raw) {
          return { error: "未登录 FiimeOPC：粘贴浏览器 Cookie，或粘贴 API Key", windows: [] }
        }
        if (!account.cookie) {
          return {
            error:
              "这条凭据是 API Key，只能跑模型；额度要用网页 Cookie 查。" +
              "再登一次「粘贴浏览器 Cookie」即可（同一账号可以同时挂两条）。",
            windows: [],
          }
        }

        const key = String(account.uid || fingerprint(account.raw))
        try {
          const dashboard = await usageCache.read(key, () => fetchDashboard(account.cookie))
          const me = await fetchMe(account.cookie).catch(() => null)
          return buildUsage({
            dashboard,
            me,
            accountName: account.name || me?.username || "",
          })
        } catch (error) {
          if (error?.signIn === "expired") {
            return {
              error: "FiimeOPC 登录已失效（Cookie 过期），重新粘贴一次浏览器 Cookie",
              windows: [],
              signIn: "expired",
            }
          }
          return { error: String(error?.message ?? error), windows: [] }
        }
      },

      // ═══ ⑥ 签到 ═══════════════════════════════════════════════════
      async checkin(getAuth) {
        const auth = await getAuth()
        const account = resolveAccount(auth, options)
        if (!account.cookie) {
          return { outcome: "failed", message: "签到需要网页 Cookie（这条凭据只有 API Key）" }
        }
        try {
          return await doCheckin({
            cookie: account.cookie,
            options,
            signature: account.name,
            accountKey: account.uid || fingerprint(account.raw),
          })
        } catch (error) {
          if (error?.signIn === "expired") {
            return { outcome: "failed", message: "FiimeOPC 登录已失效（Cookie 过期），重新登录一次" }
          }
          return { outcome: "failed", message: String(error?.message ?? error) }
        }
      },
    },

    // ═══ ⑦ 每账号的模型目录 ═══════════════════════════════════════
    provider: {
      id: PROVIDER,

      async models(provider, { auth } = {}) {
        const configured = provider?.models && typeof provider.models === "object" ? provider.models : {}
        const account = resolveAccount(auth, options)

        if (!account.raw) return { ...staticModels(), ...configured }

        let list = null
        try {
          const ensured = hasModelKey(account)
            ? { apiKey: account.apiKey }
            : await ensureModelKey(account, { options })
          if (ensured.apiKey) list = await fetchModelList(ensured.apiKey)
        } catch (error) {
          // ③ 登录失效要抛（宿主要提示重新登录）；其他错误退回静态表（① 三态降级）
          if (error?.signIn === "expired") throw error
          list = null
        }

        return buildModels({ ...provider, models: configured }, { list })
      },
    },

    // ═══ ⑧ 每请求加头 ═════════════════════════════════════════════
    "chat.headers": async (input, output) => {
      const id = input?.model?.providerID ?? input?.provider?.info?.id
      if (id !== PROVIDER) return
      output.headers["x-magpie-plugin"] = "magpie-opc-auth"
    },
  }
}

// 供测试引用（⚠ 入口文件不要导出 helper 函数，否则会被 magpie 当插件调用）
export const _internal = {
  PROVIDER,
  PROVIDER_NAME,
  BASE,
  PLUGIN_VERSION,
  MODEL_SPECS,
  staticModels,
  rawCredentialOf,
}
