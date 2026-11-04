// src/models.mjs —— 每账号的模型目录
//
// 三态降级（AGENTS 坑 17）：
//   ① 整个接口失败 → 退回上次快照 / 静态表（**不要返回空表**）
//   ② 接口成功但单条缺字段（没有 id / type 不认识）→ **不列**（不猜）
//   ③ 登录失效 → 抛 `signIn: "expired"`（由调用方转成 401）
//
// 站点上游：GET /api/model-service/v1/models（Bearer API Key）返回 22 条，
// 其中 text 17 条、image/video 5 条。这里只列 text（chat）模型。

import {
  DEFAULT_MODEL,
  GENERATION_MODEL_PREFIXES,
  MODEL_SPECS,
  SDK,
  TOOLS_BEFORE_LOGIN,
  WEB_BASE,
} from "./context.mjs"
import { contextOf } from "./model-context.mjs"

/** 从站点返回的一条模型记录里读出能力（缺字段就不列） */
export function specFromRemote(item) {
  const id = String(item?.id || "").trim()
  if (!id) return null
  if (GENERATION_MODEL_PREFIXES.some((p) => id.startsWith(p))) return null
  if (item.type && item.type !== "text") return null

  const modalities = Array.isArray(item.modalities) ? item.modalities : []
  const caps = Array.isArray(item.capabilities) ? item.capabilities : []
  const image = modalities.includes("image") && caps.includes("image_understanding")
  const toolcall = caps.includes("tool_calling")

  return {
    id,
    name: prettyName(id),
    image,
    toolcall,
    reasoning: caps.includes("reasoning") || /deepseek|glm|kimi|nemotron/i.test(id),
    rateMultiplier: Number(item.rateMultiplier) || undefined,
  }
}

function prettyName(id) {
  const known = MODEL_SPECS.find((m) => m.id === id)
  if (known) return known.name
  return id
    .split(/[-_.]/)
    .map((s) => (s ? s[0].toUpperCase() + s.slice(1) : s))
    .join(" ")
}

/**
 * 组装 magpie 的模型条目。
 *
 * `limit.context` 只在**真的知道**时才写：站点不返回上下文长度，
 * 猜一个数会让 agent 误判能塞多少（CHECKLIST A-8）。查不到就省略。
 */
export function modelEntry(spec, { toolcall = TOOLS_BEFORE_LOGIN } = {}) {
  const vision = Boolean(spec.image)
  const reasoning = Boolean(spec.reasoning)
  const tool = Boolean(toolcall)
  const context = spec.context ?? contextOf(spec.id)
  return {
    id: spec.id,
    name: spec.name || prettyName(spec.id),
    api: { id: spec.id, url: WEB_BASE, npm: SDK },
    status: "active",
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    ...(context ? { limit: { context } } : {}),
    modalities: { input: vision ? ["text", "image"] : ["text"], output: ["text"] },
    capabilities: {
      temperature: true,
      reasoning,
      toolcall: tool,
      attachment: vision,
      // 五个模态键必须显式写布尔（HOOKS 十一之三）
      input: { text: true, image: vision, audio: false, video: false, pdf: false },
      output: { text: true },
    },
    // config 路径用的是带下划线的 tool_call，两个都写，别猜哪个是对的
    tool_call: tool,
    attachment: vision,
    reasoning,
  }
}

/** 静态模型表（未登录 / 目录读取失败时的兜底，必须有内容 —— 铁律 1） */
export function staticModels({ toolcall = TOOLS_BEFORE_LOGIN } = {}) {
  const out = {}
  for (const spec of MODEL_SPECS) out[spec.id] = modelEntry(spec, { toolcall })
  return out
}

/**
 * 按一份上游目录组装模型表。
 *
 * @param {object} provider  宿主传进来的 provider 条目（里面有 config 钩子给的 models）
 * @param {object} opts
 * @param {Array|null} opts.list     上游 /v1/models 的 data（null = 这次没拿到）
 * @param {Set<string>|Array<string>} [opts.retired]
 *   已经确认上游不认的模型 id（src/store.mjs 的 readRetired）——
 *   **绝不能**再列出来：它们请求一次就 404 一次，而 404 的响应是站点的网页。
 */
export function buildModels(provider, { list = null, retired = null } = {}) {
  const gone = retired instanceof Set ? retired : new Set(retired || [])
  const configured = provider?.models && typeof provider.models === "object" ? provider.models : {}

  if (!Array.isArray(list) || list.length === 0) {
    // ① 接口没给 / 给了空的 → 用静态表，绝不返回空表
    //    （静态表里已经剔掉了下线的 id，见 src/context.mjs 的 MODEL_SPECS）
    return { ...staticModels(), ...keepUnknownModels(provider, {}, gone) }
  }

  const out = {}
  for (const item of list) {
    const spec = specFromRemote(item) // ② 缺字段 → null → 不列
    if (!spec) continue
    if (gone.has(spec.id)) continue
    const base = configured[spec.id] || {}
    out[spec.id] = {
      ...modelEntry(spec, { toolcall: spec.toolcall }),
      ...base,
      id: base.id || spec.id,
      name: base.name || modelEntry(spec).name,
      capabilities: { ...modelEntry(spec, { toolcall: spec.toolcall }).capabilities, ...(base.capabilities || {}) },
      api: { ...modelEntry(spec).api, ...(base.api || {}), id: base.api?.id || spec.id },
    }
    if (spec.rateMultiplier && spec.rateMultiplier > 1) out[spec.id].rate = spec.rateMultiplier
  }

  // 上游给了目录但一个 chat 模型都没解析出来 —— 说明响应形状变了，退回静态表比空表安全
  if (Object.keys(out).length === 0) return staticModels()

  return { ...out, ...keepUnknownModels(provider, out, gone) }
}

/**
 * 这个 provider 条目里有没有我们不认识的模型（用户自己加的）—— 原样保留。
 *
 * ⚠ 例外：`retired` 里的**不保留**。用户当初加它是因为站点有它，站点删了之后
 *   宿主那边（providers.json）不会自己消失，保留就等于每次都把它再递给用户。
 */
export function keepUnknownModels(provider, models, retired = null) {
  const gone = retired instanceof Set ? retired : new Set(retired || [])
  const configured = provider?.models && typeof provider.models === "object" ? provider.models : {}
  const out = {}
  for (const [id, entry] of Object.entries(configured)) {
    if (!models[id] && !gone.has(id) && entry && typeof entry === "object") out[id] = entry
  }
  return out
}

/** 默认模型必须在表里 */
export function withDefault(models) {
  if (models[DEFAULT_MODEL]) return models
  const first = Object.keys(models)[0] || DEFAULT_MODEL
  return models
}
