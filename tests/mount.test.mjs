// tests/mount.test.mjs —— 入口 / 九钩子挂载契约
//
// 锁的是「index.mjs 有没有被改坏」：导出形状、九项钩子齐不齐、config 有没有模型、
// loader 与 usage 在未登录时的行为、models 会不会按凭据给出静态表。
//
// 全部离线；不需要 magpie 进程、不需要凭据。
// 跑法：node --test tests/mount.test.mjs

import test from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

  // ② 邀请码注册：0.1.3 起没有「登录页填码」这一步（不再有 ask / prompts），
  //    用谁的码由供应商编辑器里的开关决定；authorize 同样要立刻返回。
  const invite = methods[1]
  assert.equal(invite.type, "oauth")
  assert.match(invite.label, /邀请码/)
  assert.equal(invite.ask, undefined, "开关版本不该再有多步问答")
  const startedInvite = Date.now()
  const inviteTicket = await invite.authorize({})
  assert.ok(Date.now() - startedInvite < 500, "authorize() 不能等网络（铁律 2）")
  assert.ok(inviteTicket.url.endsWith("/register?invite=ELJQK8Q8"), "第一次 = 内置默认码")
  assert.match(inviteTicket.instructions, /邀请上级/)
  assert.equal(inviteTicket.opened, true)
  assert.equal(typeof inviteTicket.callback, "function")

  // ③ 两条粘贴路：不要在 authorize 里做任何事
  for (const method of methods.slice(2)) {
    assert.equal(method.type, "api")
    assert.equal(typeof method.label, "string")
    assert.equal(method.authorize, undefined)
  }
})

test("插件选项：声明了 invite-first 开关（默认关 = 自动）", async () => {
  const plugin = await OpcAuthPlugin({ client: {} })
  assert.ok(Array.isArray(plugin.auth.options), "auth.options 必须是数组")
  const opt = plugin.auth.options.find((o) => o.key === "invite-first")
  assert.ok(opt, "auth.options 里必须有 invite-first")
  assert.equal(opt.default, false, "默认关 = 自动模式")
  assert.equal(typeof opt.label, "string")
  assert.ok(opt.description.length > 20, "描述要能说清两种模式")
})

test("邀请码：开关关 = 自动（上一个注册的新号优先，其次默认码）", async () => {
  const cache = join(sandbox, ".cache", "magpie")
  mkdirSync(cache, { recursive: true })
  rmSync(join(cache, "opc-invite-registered.json"), { force: true })
  rmSync(join(cache, "opc-invite.json"), { force: true })

  const plugin = await OpcAuthPlugin({ client: {} })
  const invite = plugin.auth.methods[1]

  // ① 什么都没注册过 → 内置默认码（「第一个号默认用我的」）
  assert.ok((await invite.authorize({})).url.endsWith("/register?invite=ELJQK8Q8"))

  // ② 上一个新号注册成功 → 下一个自动挂它（链式，就是自动模式的本意）
  writeFileSync(join(cache, "opc-invite-registered.json"), JSON.stringify({ code: "new00003", accountId: "u2" }))
  assert.ok((await invite.authorize({})).url.endsWith("/register?invite=NEW00003"))

  // ③ 0.1.2 手填过的码只在没有注册记录时兜底
  rmSync(join(cache, "opc-invite-registered.json"), { force: true })
  writeFileSync(join(cache, "opc-invite.json"), JSON.stringify({ code: "PREV0002" }))
  assert.ok((await invite.authorize({})).url.endsWith("/register?invite=PREV0002"))
  rmSync(join(cache, "opc-invite.json"), { force: true })
})

test("邀请码：开关开 = 首选账号的码（拿不到就回落自动）", async () => {
  const cache = join(sandbox, ".cache", "magpie")
  const config = join(sandbox, ".config", "magpie")
  mkdirSync(cache, { recursive: true })
  mkdirSync(config, { recursive: true })

  // 首选账号 + 它自己的码
  writeFileSync(join(config, "logins.json"), JSON.stringify([{ agent: "plugin:opc", home: "opc" }]))
  writeFileSync(join(config, "plugin-auth.json"), JSON.stringify({ opc: { uid: "u_me", accountId: "me" } }))
  writeFileSync(join(cache, "opc-invite-codes.json"), JSON.stringify({ u_me: { code: "pref0001", accountId: "me" } }))
  rmSync(join(cache, "opc-invite-registered.json"), { force: true })

  const firstOn = () => true
  const on = await OpcAuthPlugin({ client: {}, magpie: { option: (p, k) => p === "opc" && k === "invite-first" && firstOn() } })
  assert.ok((await on.auth.methods[1].authorize({})).url.endsWith("/register?invite=PREF0001"))
  assert.match((await on.auth.methods[1].authorize({})).instructions, /首选账号|me/)

  // 开关开着、但首选账号还没记下码 → 回落自动（默认码）
  writeFileSync(join(cache, "opc-invite-codes.json"), JSON.stringify({}))
  assert.ok((await on.auth.methods[1].authorize({})).url.endsWith("/register?invite=ELJQK8Q8"))

  // 拨回去（关）→ 立刻回到自动，不用重启
  firstOn.off = true
  const off = await OpcAuthPlugin({ client: {}, magpie: { option: () => false } })
  assert.ok((await off.auth.methods[1].authorize({})).url.endsWith("/register?invite=ELJQK8Q8"))
})

test("邀请码：选项 inviteCode 覆盖内置默认码", async () => {
  const cache = join(sandbox, ".cache", "magpie")
  mkdirSync(cache, { recursive: true })
  rmSync(join(cache, "opc-invite-registered.json"), { force: true })
  rmSync(join(cache, "opc-invite.json"), { force: true })

  const plugin = await OpcAuthPlugin({ client: {} }, { inviteCode: "opc11111" })
  const ticket = await plugin.auth.methods[1].authorize({})
  assert.ok(ticket.url.endsWith("/register?invite=OPC11111"))
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
