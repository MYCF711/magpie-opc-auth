// tests/invite.test.mjs —— 邀请码的语义锁（双模式 / 一个 magpie 开关）
//
// 0.1.3 起「用谁的码」不再是登录页上的文本框，而是供应商编辑器里的一个 Off/On 开关：
//   开关关（默认）  自动 —— 跟随上一个注册成功的新号；没有就用内置默认码
//   开关开          首选 —— 挂到 magpie 账号页「首选」那个账号名下
//
// 这一块出事的样子是「码填了、也注册成功了，但被邀请的人挂在了错误的人名下」——
// 不报错、不崩，只是奖励发给了别人。所以每一档都要单独锁。
//
// 全部离线：不登录、不打网络。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// 隔离 HOME：缓存与 magpie 的配置文件都从沙箱里读，不能污染真实目录
const sandbox = mkdtempSync(join(tmpdir(), "opc-invite-"))
process.env.HOME = sandbox
process.env.USERPROFILE = sandbox

const {
  INVITE_FIRST_OPTION,
  createInviteCodes,
  createInviteStore,
  createRegisteredInvite,
  inviteNote,
  preferredAccount,
  preferredHome,
  resolveInviteCode,
} = await import("../src/invite.mjs")
const { inviteRegisterUrl } = await import("../src/api.mjs")

// 假码：不是任何真实账号的邀请码
const AUTHOR = "AUTH0001"
const PREV = "PREV0002"
const NEW = "NEW00003"

test("开关 key 是 invite-first（和 index.mjs 声明的是同一个）", () => {
  assert.equal(INVITE_FIRST_OPTION, "invite-first")
})

test("resolveInviteCode：开关关 = 自动（注册码 → 旧手填 → 默认码）", () => {
  // 自动：最后注册成功的新号优先
  assert.deepEqual(
    resolveInviteCode({ firstOn: false, registered: { code: NEW }, rolling: PREV, fallback: AUTHOR }),
    { code: NEW, source: "registered" },
  )
  // 没有注册记录 → 0.1.2 手填过的码
  assert.deepEqual(resolveInviteCode({ firstOn: false, registered: null, rolling: PREV, fallback: AUTHOR }), {
    code: PREV,
    source: "rolling",
  })
  // 什么都没有 → 内置默认码（「第一个号默认用我的」就是这一档）
  assert.deepEqual(resolveInviteCode({ firstOn: false, registered: null, rolling: "", fallback: AUTHOR }), {
    code: AUTHOR,
    source: "default",
  })
})

test("resolveInviteCode：开关开 = 首选（首选账号的码 → 回落到自动链）", () => {
  const preferred = { home: "opc", uid: "u_1", accountId: "me" }
  // 首选账号有码 → 用它，哪怕注册码更新
  assert.deepEqual(
    resolveInviteCode({
      firstOn: true,
      preferred,
      codes: { u_1: { code: PREV } },
      registered: { code: NEW },
      fallback: AUTHOR,
    }),
    { code: PREV, source: "preferred" },
  )
  // 首选账号还没记下码（第一次登录前）→ 回落自动，不能凭空生成
  assert.deepEqual(
    resolveInviteCode({ firstOn: true, preferred, codes: {}, registered: { code: NEW }, fallback: AUTHOR }),
    { code: NEW, source: "registered" },
  )
  // 没有首选账号（单账号时 magpie 可能没写 first/order）→ 也回落
  assert.deepEqual(resolveInviteCode({ firstOn: true, preferred: null, registered: null, fallback: AUTHOR }), {
    code: AUTHOR,
    source: "default",
  })
})

test("createInviteCodes：按账号存码，空值不写，读不到当没有", () => {
  const codes = createInviteCodes("zzopc")
  assert.equal(codes.get("u_1"), null)
  codes.note("u_1", { code: " abcd1234 ", accountId: "me" })
  assert.deepEqual(codes.get("u_1"), { code: "ABCD1234", accountId: "me", at: codes.get("u_1").at })
  // 空 uid / 空码不写
  codes.note("", { code: NEW })
  codes.note("u_2", { code: "" })
  assert.equal(codes.get("u_2"), null)
  assert.deepEqual(Object.keys(codes.readAll()), ["u_1"])
})

test("createRegisteredInvite：只认最后一个注册成功的新号", () => {
  const reg = createRegisteredInvite("zzopc")
  assert.equal(reg.read(), null)
  reg.note({ code: " new00003 ", accountId: "fresh" })
  assert.deepEqual(reg.read(), { code: NEW, accountId: "fresh", at: reg.read().at })
  // 再注册一个 → 覆盖
  reg.note({ code: "another9", accountId: "fresh2" })
  assert.equal(reg.read().code, "ANOTHER9")
})

test("createInviteStore：0.1.2 的旧策略文件只当兜底", () => {
  const store = createInviteStore("zzopc")
  assert.equal(store.read(), "")
  store.write(PREV, { source: "chosen" })
  assert.equal(store.read(), PREV)
  store.write("", { source: "x" })
  assert.equal(store.read(), PREV, "空码不能覆盖已有值")
})

test("preferredAccount：从 logins.json + plugin-auth.json 读「首选那个号」", () => {
  const dir = join(sandbox, ".config", "magpie")
  mkdirSync(dir, { recursive: true })
  const loginsFile = join(dir, "logins.json")
  const authFile = join(dir, "plugin-auth.json")

  writeFileSync(
    loginsFile,
    JSON.stringify([
      { agent: "plugin:other", home: "other" },
      { agent: "plugin:opc", home: "opc", order: 2 },
      { agent: "plugin:opc", home: "opc#1", order: 1 },
    ]),
  )
  writeFileSync(authFile, JSON.stringify({ opc: { uid: "u_first" }, "opc#1": { uid: "u_second" } }))

  // 最小正 order 的那个是首选（magpie 的判定顺序）
  assert.equal(preferredHome("opc", { loginsFile, authFile }), "opc#1")
  assert.deepEqual(preferredAccount("opc", { loginsFile, authFile }), { home: "opc#1", uid: "u_second", accountId: "" })

  // `first: true` 优先于 order
  writeFileSync(loginsFile, JSON.stringify([{ agent: "plugin:opc", home: "opc#1", order: 1 }, { agent: "plugin:opc", home: "opc", first: true }]))
  assert.equal(preferredHome("opc", { loginsFile, authFile }), "opc")

  // 没有这个 provider 的登录 → 空（首选模式会回落到自动）
  assert.equal(preferredHome("nope", { loginsFile, authFile }), "")
  assert.equal(preferredAccount("nope", { loginsFile, authFile }), null)
})

test("inviteNote：文案和实际用的码同源", () => {
  assert.match(inviteNote({ code: PREV, source: "preferred", preferred: { accountId: "me" } }), /me/)
  assert.match(inviteNote({ code: PREV, source: "preferred", preferred: null }), /首选账号/)
  assert.match(inviteNote({ code: NEW, source: "registered" }), /上一个注册成功的新号/)
  assert.match(inviteNote({ code: PREV, source: "rolling" }), /上次用过的码/)
  assert.match(inviteNote({ code: AUTHOR, source: "default" }), /内置默认码/)
  assert.match(inviteNote({ code: "", source: "default" }), /不带邀请码/)
  // 打码过的码要原样出现，不能只写「某个账号」
  assert.match(inviteNote({ code: PREV, source: "rolling" }), new RegExp(PREV))
})

test("inviteRegisterUrl：带码 → 注册页带 ?invite=；空码 → 普通注册页", () => {
  assert.equal(inviteRegisterUrl(AUTHOR), `https://opc.fiime.cn/register?invite=${AUTHOR}`)
  assert.equal(inviteRegisterUrl(""), "https://opc.fiime.cn/zh-cn/register")
  assert.equal(
    inviteRegisterUrl(AUTHOR, "https://opc.fiime.cn/register?invite=SITEURL1"),
    "https://opc.fiime.cn/register?invite=SITEURL1",
    "站点自己给的 url 优先",
  )
})
