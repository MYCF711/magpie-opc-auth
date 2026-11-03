// tests/mount.test.mjs —— 入口 / 九钩子挂载契约
//
// 锁的是「index.mjs 有没有被改坏」：导出形状、九项钩子齐不齐、config 有没有模型、
// loader 与 usage 在未登录时的行为、models 会不会按凭据给出静态表。
//
// 全部离线；不需要 magpie 进程、不需要凭据。
// 跑法：node --test tests/mount.test.mjs

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// 隔离 HOME：邀请码那条登录方式的 `authorize()` 会写 ~/.cache/magpie/opc-invite.json，
// 不能污染真实目录。环境变量必须在 index.mjs 被求值**之前**设好，所以这里用动态 import。
const sandbox = mkdtempSync(join(tmpdir(), "opc-mount-"))
process.env.HOME = sandbox
process.env.USERPROFILE = sandbox

const entry = await import("../index.mjs")
const { _internal, OpcAuthPlugin } = entry

/** 一条形状合法的 Cookie（不会打任何网络请求） */
// 假值：只用来验形状，不是真凭证
const BROWSER_LOGIN = "ANASID=fake-anasid; opc_sid=fake-opc-sid; ANACCOUNT=fake-account"
/** 一条形状合法的 API Key */
const API_KEY = "opc_sk_0123456789abcdef0123456789abcdef01234567"

test("入口只导出一个函数（插件工厂）", () => {
  const functions = Object.entries(entry)
    .filter(([, value]) => typeof value === "function")
    .map(([key]) => key)
  assert.deepEqual(functions, ["OpcAuthPlugin"])
})

test("_internal 是对象，helper 不暴露成顶层函数导出", () => {
  assert.equal(typeof _internal, "object")
  assert.equal(_internal.PROVIDER, "opc")
  assert.equal(typeof _internal.staticModels, "function")
  assert.ok(Array.isArray(_internal.MODEL_SPECS) && _internal.MODEL_SPECS.length > 0)
})

test("九项钩子齐全", async () => {
  const plugin = await OpcAuthPlugin({ client: {}, directory: undefined })
  assert.equal(typeof plugin.config, "function")
  assert.ok(plugin.auth && typeof plugin.auth === "object")
  assert.equal(plugin.auth.provider, _internal.PROVIDER)
  assert.equal(typeof plugin.auth.refresh, "function")
  assert.equal(typeof plugin.auth.loader, "function")
  assert.equal(typeof plugin.auth.usage, "function")
  assert.equal(typeof plugin.auth.checkin, "function")
  assert.equal(typeof plugin.provider.models, "function")
  assert.equal(typeof plugin["chat.headers"], "function")
  assert.equal(plugin.provider.id, _internal.PROVIDER)
  assert.ok(plugin.auth.icon?.startsWith("data:image/"), "图标必须内嵌（外部 URL 在 git 源下不渲染）")
  assert.ok(Number.isInteger(plugin.auth.maxConcurrency) && plugin.auth.maxConcurrency >= 1)
})

test("config() 未登录也声明了模型，且 modalities / 五个 input 布尔都在", async () => {
  const plugin = await OpcAuthPlugin({ client: {} })
  const cfg = {}
  await plugin.config(cfg)
  const provider = cfg.provider?.[_internal.PROVIDER]
  assert.ok(provider, "必须声明 provider")
  assert.equal(provider.npm, "@ai-sdk/openai-compatible")
  const models = provider.models
  assert.ok(models && Object.keys(models).length > 0, "config.models 不能为空（铁律 1）")

  for (const [id, model] of Object.entries(models)) {
    assert.ok(Array.isArray(model.modalities.input), `${id}.modalities.input 必须给`)
    assert.deepEqual(model.modalities.output, ["text"], `${id}.modalities.output 必须给`)
    for (const key of ["text", "image", "audio", "video", "pdf"]) {
      assert.equal(typeof model.capabilities.input[key], "boolean", `${id}.capabilities.input.${key} 必须是布尔`)
    }
    assert.equal(typeof model.capabilities.output.text, "boolean")
    // 上下文只在真的知道时才写；写了就必须是数字
    if (model.limit?.context !== undefined) {
      assert.equal(typeof model.limit.context, "number", `${id}.limit.context 必须是数字`)
    }
  }

  // 能力来自站点实测：能收图的三条必须为 true，纯文本的必须为 false（坑 25）
  assert.equal(models["deepseek-v4-pro"].capabilities.input.image, true)
  assert.equal(models["glm-5-2"].capabilities.input.image, false)
  assert.equal(models["glm-5-2"].capabilities.toolcall, true)
})

test("登录方式：隔离浏览器 + 邀请码注册 + 两条粘贴路", async () => {
  const plugin = await OpcAuthPlugin({ client: {} })
  const methods = plugin.auth.methods
  assert.ok(Array.isArray(methods) && methods.length === 4)

  // ① 隔离浏览器登录：authorize 必须**立刻**返回，真正的等待在 callback
  const browser = methods[0]
  assert.equal(browser.type, "oauth")
  const started = Date.now()
  const ticket = await browser.authorize()
  assert.ok(Date.now() - started < 500, "authorize() 不能等网络（铁律 2）")
  assert.equal(typeof ticket.url, "string")
  assert.equal(ticket.opened, true)
  assert.equal(ticket.method, "auto")
  assert.equal(typeof ticket.callback, "function")

  // ② 邀请码注册：多步问答必须用 ask()，不是静态 prompts 数组（AGENTS 坑 26）；
  //    authorize 同样要立刻返回，并且拼出来的注册页 URL 必须带着码。
  const invite = methods[1]
  assert.equal(invite.type, "oauth")
  assert.match(invite.label, /邀请码/)
  assert.equal(typeof invite.ask, "function")
  assert.equal(typeof invite.prompts, "object", "面板列表要靠 prompts 显示第一个问题")
  assert.equal((await invite.ask({})).key, "invite")
  assert.equal(await invite.ask({ invite: "ABCD1234" }), null)
  const startedInvite = Date.now()
  const inviteTicket = await invite.authorize({ invite: "ABCD1234" })
  assert.ok(Date.now() - startedInvite < 500, "authorize() 不能等网络（铁律 2）")
  assert.match(inviteTicket.url, /\/register\?invite=ABCD1234$/)
  assert.equal(inviteTicket.opened, true)
  assert.equal(typeof inviteTicket.callback, "function")

  // ③ 两条粘贴路：不要在 authorize 里做任何事
  for (const method of methods.slice(2)) {
    assert.equal(method.type, "api")
    assert.equal(typeof method.label, "string")
    assert.equal(method.authorize, undefined)
  }
})

test("邀请码注册：第一个号默认带默认码，之后自动 / 首选 / 不带码三档", async () => {
  // 模拟「第一次安装」：策略文件还不存在
  const policy = join(sandbox, ".cache", "magpie", "opc-invite.json")
  rmSync(policy, { force: true })

  const plugin = await OpcAuthPlugin({ client: {} })
  const invite = plugin.auth.methods[1]

  // ① 第一次、什么都不填 → 默认邀请码（DEFAULT_INVITE）
  const first = await invite.authorize({})
  assert.match(first.url, /\/register\?invite=ELJQK8Q8$/, "第一个号默认带作者的码")

  // ② 填别人的码 → 首选：用他填的，并存下来
  const chosen = await invite.authorize({ invite: "zzzz9999" })
  assert.match(chosen.url, /\/register\?invite=ZZZZ9999$/, "填的码要归一化成大写")

  // ③ 留空 / 输入 1 → 自动：沿用上次存下的码（不会被默认码覆盖回去）
  assert.match((await invite.authorize({})).url, /invite=ZZZZ9999$/)
  assert.match((await invite.authorize({ invite: "1" })).url, /invite=ZZZZ9999$/)

  // ④ 输入 - → 不带邀请码，落普通注册页
  const none = await invite.authorize({ invite: "-" })
  assert.equal(none.url, "https://opc.fiime.cn/zh-cn/register", "- 要能显式关掉邀请码")
  // ⑤ 而且「不带」会被记住：下一位留空时仍然不带
  assert.equal((await invite.authorize({})).url, "https://opc.fiime.cn/zh-cn/register")
})

test("邀请码注册：选项 inviteCode 覆盖内置默认码", async () => {
  const policy = join(sandbox, ".cache", "magpie", "opc-invite.json")
  rmSync(policy, { force: true })

  const plugin = await OpcAuthPlugin({ client: {} }, { inviteCode: "opc11111" })
  const ticket = await plugin.auth.methods[1].authorize({})
  assert.match(ticket.url, /\/register\?invite=OPC11111$/)
})

test("refresh() 不续期也不覆盖字段", async () => {
  const plugin = await OpcAuthPlugin({ client: {} })
  const result = await plugin.auth.refresh({ key: BROWSER_LOGIN, metadata: { kind: "cookie" } })
  assert.equal(result, undefined, "粘贴型凭据没有 refresh_token，必须返回 undefined")
})

test("loader() 未登录返回空对象（不抛）", async () => {
  const plugin = await OpcAuthPlugin({ client: {} })
  const result = await plugin.auth.loader(async () => null)
  assert.deepEqual(result, {})
})

test("usage() 未登录返回 error 且有 windows 数组", async () => {
  const plugin = await OpcAuthPlugin({ client: {} })
  const result = await plugin.auth.usage(async () => null)
  assert.equal(typeof result.error, "string")
  assert.ok(Array.isArray(result.windows))
})

test("usage() 只有 API Key 时明确说「查不了额度」", async () => {
  const plugin = await OpcAuthPlugin({ client: {} })
  const result = await plugin.auth.usage(async () => ({ key: API_KEY }))
  assert.match(result.error, /Cookie|额度/)
  assert.deepEqual(result.windows, [])
})

test("checkin() 只有 API Key 时返回 failed 而不是假装成功", async () => {
  const plugin = await OpcAuthPlugin({ client: {} })
  const result = await plugin.auth.checkin(async () => ({ key: API_KEY }))
  assert.equal(result.outcome, "failed")
})

test("models() 未登录返回静态表（不是空表）", async () => {
  const plugin = await OpcAuthPlugin({ client: {} })
  const provider = { models: {} }
  const models = await plugin.provider.models(provider, { auth: null })
  assert.ok(Object.keys(models).length > 0, "未登录也必须给出模型（铁律 1）")
  assert.ok(models["deepseek-v4-flash"], "默认模型必须在表里")
})

test("chat.headers 只对本 provider 生效", async () => {
  const plugin = await OpcAuthPlugin({ client: {} })
  const hit = { headers: {} }
  await plugin["chat.headers"]({ model: { providerID: _internal.PROVIDER } }, hit)
  assert.equal(hit.headers["x-magpie-plugin"], "magpie-opc-auth")

  const miss = { headers: {} }
  await plugin["chat.headers"]({ model: { providerID: "other" } }, miss)
  assert.deepEqual(miss.headers, {})
})
