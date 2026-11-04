// 共享上下文 —— 框里所有小插头都读这一份
//
// ⚠ 改这里，不要改各个 hook 文件里的常量。
//   针脚模块只关心「怎么填这一个针脚」，厂商信息全在这儿。

/** 厂商 id：agent 用 `<id>/<model>` 命名，改完全世界都要跟着改 */
export const PROVIDER = "opc"

/** 卡片上显示的供应商名：必须 <中文> <English>，英文照抄厂商官方品牌写法 */
export const PROVIDER_NAME = "一人公司社区 FiimeOPC"

/** 网页域：额度、账号、签到都走这里 */
export const WEB_BASE = "https://opc.fiime.cn"

/** 模型通道基址（OpenAI Chat 形状，SDK 会自己拼 /chat/completions） */
export const BASE = "https://opc.fiime.cn/api/model-service/v1"

/**
 * 决定 API 形状：
 *   @ai-sdk/openai-compatible → Chat completions  /chat/completions
 *
 * FiimeOPC 的模型端点是标准 OpenAI Chat 形状（实测 200 + SSE + tool_calls + usage），
 * 但它**要求 Bearer API Key**（`opc_sk_…`）—— 网页 cookie 打这个端点会回
 * `{"error":{"type":"invalid_api_key"}}`。所以模型通道必须由插件用 cookie 自动换一把 key。
 */
export const SDK = "@ai-sdk/openai-compatible"

/** 网页 cookie 的有效期（服务端不滑动续期，实测响应里没有 Set-Cookie） */
export const COOKIE_TTL_MS = 7 * 24 * 3600_000

export const PLUGIN_VERSION = "0.1.6"

/**
 * 请求必须带 UA：站点对 UA 敏感的接口会回「请求异常，请稍后再试」（`requireCaptcha`）。
 *
 * ⚠ **值必须是「官方客户端」UA，不能是 `<产品名>/<版本号>`**：上游网关按
 * `<product>/<version>` 形态认「第三方客户端」，命中即回
 * `403 {"error_code":"TM.00000001","error_msg":"网络繁忙，请稍后重试"}`；
 * 不显式设 UA 时宿主会把 `magpie/<version>` 原样透传，同样命中。
 * FiimeOPC 的官方客户端就是官方网页（Cookie 会话 / 网页里创建的 API Key），
 * 所以这里逐字用一条完整合法的 Chrome UA —— 别改成别的版本号，也别退回产品名。
 */
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

/** 控制台路由（从前端 bundle 与页面实测出来的真实路径，别改） */
export const ROUTES = Object.freeze({
  modelService: `${WEB_BASE}/zh-cn/model-service`,
  keys: `${WEB_BASE}/zh-cn/model-service?tab=keys`,
  benefits: `${WEB_BASE}/zh-cn/model-service?tab=benefits`,
  profile: `${WEB_BASE}/zh-cn/profile`,
  messageWall: `${WEB_BASE}/zh-cn/message-wall`,
  community: `${WEB_BASE}/zh-cn/community`,
  hub: `${WEB_BASE}/zh-cn/hub`,
})

/**
 * 图标 —— **两处必须一致**，缺一份就有地方显示灰方块：
 *   auth.icon（本文件导出）  → 供应商列表那一行、用量概览的卡
 *   package.json 的 magpie.icon → 插件列表那一行、插件详情页左上角
 */
export const ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCIgZmlsbD0ibm9uZSI+CiAgPHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTYiIGZpbGw9IiNiNTQ2MmUiLz4KICA8IS0tIEYg5a2X5q+N6J6N5ZCI5Lq65b2i77ya56uW57q/5piv6Lqr5L2TK+WktOmDqO+8jOaoque6v+aYr+aJi+iHguWSjOi/nuaOpSAtLT4KICA8Y2lyY2xlIGN4PSIyNCIgY3k9IjE4IiByPSI1LjUiIGZpbGw9IiNmZmYiLz4KICA8IS0tIEYg55qE56uW57q/ID0g6Lqr5L2TIC0tPgogIDxwYXRoIGQ9Ik0yNCAyNiBMMjQgNDgiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSI1IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz4KICA8IS0tIEYg5LiK5qiq57q/ID0g5Ly45bGV55qE5omL6IeCIC0tPgogIDxwYXRoIGQ9Ik0yNCAzMCBMNDIgMzAiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSI1IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz4KICA8IS0tIEYg5LiL5qiq57q/77yM5b6u5b6u5LiK5oms77yM5pqX56S66L+e5o6lL+WQkeWJjSAtLT4KICA8cGF0aCBkPSJNMjQgNDAgTDM4IDQwIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+CiAgPCEtLSDlj7PkvqflsI/lnIbngrkgPSDnpL7ljLroioLngrkv5LyZ5Ly0IC0tPgogIDxjaXJjbGUgY3g9IjQ2IiBjeT0iMjIiIHI9IjMuNSIgZmlsbD0iI2ZmZiIgb3BhY2l0eT0iLjciLz4KICA8Y2lyY2xlIGN4PSI0NiIgY3k9IjQwIiByPSIyLjUiIGZpbGw9IiNmZmYiIG9wYWNpdHk9Ii40NSIvPgo8L3N2Zz4K"

/**
 * 模型能力表 —— **上下文长度没有实测值，所以这里不写 context**。
 *
 * 站点 `/api/model-service/v1/models` 只给 `type` / `modalities` / `capabilities` /
 * `rateMultiplier`，没有上下文窗口字段；页面与文档也没写。
 * 按 CHECKLIST A-8「上下文窗口是实测值，不是猜的」，这里只声明已知的能力，
 * 窗口长度交给 `src/model-context.mjs` 从宿主缓存里查（查不到就不写）。
 *
 * ⚠ 这张表是**未登录 / 目录拉不到**时的兜底，所以它只该列站点当前真的在服务的模型：
 *   `deepseek-v4-1-flash-1017` 已于 2026-11-04 从站点目录下线（21 条里没有它，
 *   请求它回 404 + 站点 HTML 落地页），已从本表删除 —— 别再按老清单加回来。
 *
 * 字段：id / name / image（能不能收图，**必须写成布尔值**）/ toolcall / reasoning
 */
export const MODEL_SPECS = Object.freeze([
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", image: true, toolcall: true, reasoning: true },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", image: true, toolcall: true, reasoning: true },
  { id: "deepseek-v4-flash-0731", name: "DeepSeek V4 Flash 0731", image: true, toolcall: true, reasoning: true },
  { id: "glm-5-2", name: "GLM 5.2", image: false, toolcall: true },
  { id: "glm-5-2-l", name: "GLM 5.2 L", image: false, toolcall: true },
  { id: "kimi-k3", name: "Kimi K3", image: true, toolcall: true, reasoning: true },
  { id: "mixmodel", name: "MixModel", image: true, toolcall: true },
  { id: "qwen3-8-27b", name: "Qwen3 8B/27B", image: false, toolcall: true },
  { id: "dots-3-note-preview", name: "Dots 3 Note Preview", image: false, toolcall: true },
  { id: "north-mini-code", name: "North Mini Code", image: false, toolcall: true },
  { id: "laguna-xs-2-1", name: "Laguna XS 2.1", image: false, toolcall: true },
  { id: "nemotron-3-ultra-550b-a55b", name: "Nemotron 3 Ultra 550B", image: false, toolcall: true },
  { id: "space-bunny-alpha", name: "Space Bunny Alpha", image: false, toolcall: true },
  { id: "sensenova-6-8-flash-lite", name: "SenseNova 6.8 Flash Lite", image: true, toolcall: true },
  { id: "opc-txt-v1", name: "OPC Text v1", image: false, toolcall: true },
  { id: "opc-txt-v2", name: "OPC Text v2", image: false, toolcall: true },
])

/** 登录前先乐观地写 true；登录后由 src/models.mjs 按模型的 capabilities 纠正 */
export const TOOLS_BEFORE_LOGIN = true

/** 默认模型 */
export const DEFAULT_MODEL = "deepseek-v4-flash"

/** 生成类模型不列进 chat 列表（vision 模型的 id 前缀） */
export const GENERATION_MODEL_PREFIXES = ["opc-image", "opc-video", "sensenova-u1"]

/** 网页写操作要带的 CSRF 头名（/api/csrf-token 返回的 headerName 也是这个） */
export const CSRF_HEADER = "X-CSRF-Token"

/** 打卡签到圈 —— 「搭子广场发帖」任务发在这里（从前端圈子列表实测到的 id） */
export const CHECKIN_CIRCLE = "cc_mufivzctc534ec"

/** 项目任务的默认项目链接（站点不允许留空） */
export const PROJECT_LINK = "https://opc.fiime.cn"

/** 每日任务的 id（/api/model-service 的 benefits.tasks） */
export const DAILY_TASK_IDS = Object.freeze([
  "message_wall",
  "plaza_post",
  "project_publish",
  "requirement_publish",
])

/**
 * 默认邀请码 —— 新用户**第一次**用「邀请码注册（隔离窗口）」时自动带上的码。
 *
 * 语义（三档，见 src/invite.mjs 与 README「邀请」）：
 *   · 什么都不填 / 输入 1 → 自动：沿用当前策略，没有策略时就是这里这个码
 *   · 填别的码           → 首选：用用户填的（存进 `~/.cache/magpie/opc-invite.json`）
 *   · 输入 -             → 不带邀请码：打开普通注册页
 *
 * 想换成自己的码：插件选项里写 `"inviteCode": "你自己的码"`（留空 = 用这里的默认值）。
 * 邀请码本身不是凭证 —— 它的用途就是被分享出去，所以写进公开仓库是安全的。
 */
export const DEFAULT_INVITE = "ELJQK8Q8"
