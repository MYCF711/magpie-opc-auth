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
  DEFAULT_INVITE,
  ICON,
  MODEL_SPECS,
  PLUGIN_VERSION,
  PROVIDER,
  PROVIDER_NAME,
  SDK,
  WEB_BASE,
} from "./src/context.mjs"
import { createUsageCache } from "./src/usage-cache.mjs"
import { fetchDashboard, fetchInvite, fetchMe, fetchModelList, inviteRegisterUrl } from "./src/api.mjs"
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
import {
  INVITE_FIRST_OPTION,
  createInviteCodes,
  createInviteStore,
  createRegisteredInvite,
  inviteNote,
  preferredAccount,
  resolveInviteCode,
} from "./src/invite.mjs"

export const OpcAuthPlugin = async (ctx, rawOptions) => {
  const options = normaliseOptions(rawOptions)

  // 额度卡片会被频繁刷新：成功 60 秒、失败 5 秒，同 key 并发合并。
  const usageCache = createUsageCache({ ttlMs: 60_000, failTtlMs: 5_000 })

  // ═══ 邀请码：双模式，由 magpie 的插件选项（供应商编辑器里的开关）决定 ═══
  //
  //   开关关（默认）  自动 —— 跟随「最后一个注册成功的新号」自己的码；
  //                         一个都没有时，用内置默认码（作者的码）
  //   开关开          首选 —— 挂到 magpie 账号页「首选」那个账号名下
  //
  // 三份缓存都在 `~/.cache/magpie/`（全可删）：
  //   opc-invite-codes.json       每账号自己的码（首选模式用）
  //   opc-invite-registered.json  最后注册的新号的码（自动模式用）
  //   opc-invite.json             0.1.2 手填过的码，只当兜底
  const inviteCodes = createInviteCodes(PROVIDER)
  const registeredInvite = createRegisteredInvite(PROVIDER)
  const rollingInvite = createInviteStore(PROVIDER)

  // 默认邀请码：选项 `inviteCode` 优先，其次内置的 DEFAULT_INVITE。
  // 「第一个号默认用我的」就靠它 —— 新用户第一次注册自动带上，不用自己填。
  const defaultInvite = () => String(options.inviteCode || DEFAULT_INVITE).trim().toUpperCase()

  /**
   * 开关每次现读 —— magpie 拨一下立刻生效，不重启 host。
   * 读不到（老版本没有 option / 抛错）一律当关 = 自动，升级上来的行为不变。
   */
  const inviteFirstOn = () => {
    try {
      return ctx?.magpie?.option?.(PROVIDER, INVITE_FIRST_OPTION) === true
    } catch {
      return false
    }
  }

  /** 这次注册该带谁的码 —— 唯一做决定的地方（文案也从这里取，不各写一份） */
  const pickInvite = () =>
    resolveInviteCode({
      firstOn: inviteFirstOn(),
      preferred: preferredAccount(PROVIDER),
      codes: inviteCodes.readAll(),
      registered: registeredInvite.read(),
      rolling: rollingInvite.read(),
      fallback: defaultInvite(),
    })

  /**
   * 登录成功后的后台动作：建 API Key + 跑今天的每日任务 + 记下这个账号的邀请码。
   *
   * ⚠ 故意不 await：登录结果要立刻还给用户（铁律 2 的延伸），
   *   而「建 key」和「发一条寄语」都是秒级网络动作，让它们在后台跑完就行。
   *   失败不抛 —— 用户下次刷新卡片会看到具体缺什么。
   *
   * @param {object} [o]
   * @param {boolean} [o.registered] 这次是**注册**成功（只有注册才写 registered 码）
   */
  const afterLogin = async (cookie, { registered = false, account } = {}) => {
    const acct = { cookie, apiKey: "", uid: account?.uid || fingerprint(cookie) }
    try {
      await ensureModelKey(acct, { options })
    } catch {
      /* 建 key 失败不阻塞登录 */
    }
    try {
      await runDailyTasks({ cookie, options, signature: "", accountKey: acct.uid })
    } catch {
      /* 任务失败留给卡片显示 */
    }
    // 顺手记下这个账号自己的邀请码：首选模式要用它，而 authorize 是同步的。
    // ⚠ 普通登录**只更新 codes**，不碰 registered —— 否则重登旧号会把自动模式的
    //   落点换回旧号（magicrew 踩过的坑）。
    try {
      const inv = await fetchInvite(cookie)
      if (inv.code) {
        const accountId = account?.name || ""
        inviteCodes.note(acct.uid, { code: inv.code, accountId })
        if (registered) registeredInvite.note({ code: inv.code, accountId })
      }
    } catch {
      /* 邀请码不是登录的必要条件 */
    }
  }

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

      // ═══ 插件选项：供应商编辑器里的一排 Off/On 开关 ═════════════════
      //
      // 这是 magpie 自己的字段（auth.options，#2038）：每项都是 Off/On，
      // 存在 `settings.PluginOptions[provider][key]`，插件用
      // `input.magpie.option(provider, key)` 读，**拨一下立刻生效、不重启 host**。
      //
      // ⚠ 只能布尔（`map[string]map[string]bool`，设置接口入参也只有 `{provider, key, on}`）——
      //   装不下字符串，也做不了「从 N 项里选一个」。要指定任意码只能改
      //   `inviteCode` 选项（plugins.json 的 JSON 配置）或内置的 DEFAULT_INVITE。
      options: [
        {
          key: INVITE_FIRST_OPTION,
          label: "邀请码挂到首选账号",
          description:
            "开：新号注册挂在 magpie 账号页「首选」那个账号名下（用它的邀请码）。" +
            "关：跟随上一个注册成功的新号，一个都没有时用内置默认码（默认）。" +
            "两种模式点登录时都会写明这次挂在谁名下。",
          default: false,
        },
      ],

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
                  // 登录成功 → 后台把「API Key」「今天的每日任务」和「这个号的邀请码」一起收掉。
                  // ⚠ 普通登录**不写** registered 码 —— 否则重登旧号会把自动模式的落点换回旧号。
                  if (result?.type === "success" && result.key) {
                    void afterLogin(result.key, { account: { uid: result.uid, name: result.accountId } })
                  }
                  return result
                } catch (error) {
                  return { type: "failed", error: String(error?.message || error).slice(0, 400) }
                }
              },
            }
          },
        },
        // ── 方式二：邀请码注册（隔离窗口）→ 自动登录 ─────────────────
        //
        // ⚠ 本站的邀请码**只影响注册**（`/register?invite=<code>`）：老账号在
        //   登录 URL 上带码没有任何效果（实测），事后也补不了。
        //
        // 0.1.3 起「用谁的码」不再是登录页上的文本框，而是供应商编辑器里
        // 「插件选项 → 邀请码挂到首选账号」那个开关（magpie 的 auth.options）：
        //   关（默认）= 自动：跟随上一个注册成功的新号；没有就用内置默认码
        //   开        = 首选：挂到 magpie 账号页「首选」那个账号名下
        // 点进来时 instructions 会写明这次挂在谁名下 —— 和实际用的码同源。
        {
          type: "oauth",
          label: "邀请码注册（隔离窗口）→ 自动登录",
          // authorize 必须立刻返回（铁律 2）：只把「窗口会开」这件事交回去
          async authorize() {
            const picked = pickInvite()
            const url = inviteRegisterUrl(picked.code)
            return {
              url,
              instructions:
                inviteNote({ ...picked, preferred: preferredAccount(PROVIDER) }) +
                "。插件会开一个隔离的浏览器窗口（一次性 profile，不读也不写你日常浏览器的数据）。" +
                "在窗口里完成注册（或直接登录），**别关窗口**，等它自己收工 —— 插件会从 CDP 收下登录态。",
              method: "auto",
              opened: true,
              async callback() {
                try {
                  const result = await loginViaBrowser({ url })
                  // 登录成功 → 后台把「API Key」「今天的每日任务」和「这个号的邀请码」一起收掉
                  if (result?.type === "success" && result.key) {
                    // 这条路是**注册**入口：注册成功的新号成为自动模式的下一个落点
                    void afterLogin(result.key, {
                      registered: true,
                      account: { uid: result.uid, name: result.accountId },
                    })
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
          // 账号名与邀请码都是「有更好、没有也照样出卡」的只读信息：
          // 各自失败就各自空着，绝不让主要额度跟着一起挂掉。
          const [me, invite] = await Promise.all([
            fetchMe(account.cookie).catch(() => null),
            usageCache.read(`${key}|invite`, () => fetchInvite(account.cookie)).catch(() => null),
          ])
          // 顺手记下这个账号自己的邀请码：首选模式要用它，而 authorize 是同步的。
          if (invite?.code) {
            inviteCodes.note(account.uid || key, { code: invite.code, accountId: account.name || me?.username || "" })
          }
          return buildUsage({
            dashboard,
            me,
            invite,
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
