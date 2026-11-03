// tests/invite.test.mjs —— 邀请码的语义锁
//
// 这一块出事的样子是「邀请码填了、也登录成功了，但注册页上根本没带上」——
// 不报错、不崩，被邀请的人只是没挂上关系（AGENTS 坑 26）。
//
// 本站的码**只在注册时生效**（`/register?invite=<code>`），所以除了通用的
// 「0 / 空 / 1 沿用当前」之外，还要锁住「拼出来的 URL 到底带没带码」。
//
// 全部离线：不登录、不打网络。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// 隔离 HOME：策略文件写在 ~/.cache/magpie 下，不能污染真实目录
const sandbox = mkdtempSync(join(tmpdir(), "opc-invite-"))
process.env.HOME = sandbox
process.env.USERPROFILE = sandbox

const { INVITE_NONE, createInviteStore, inviteHint, pickInvite, resolveInvite, makeInviteMethod } = await import(
  "../src/invite.mjs"
)
const { inviteRegisterUrl } = await import("../src/api.mjs")

// 假码：不是任何真实账号的邀请码
const FAKE = "ABCD1234"

test("resolveInvite：0 / 空 / 1 沿用当前，其它当新码", () => {
  assert.equal(resolveInvite("", FAKE), FAKE)
  assert.equal(resolveInvite("0", FAKE), FAKE)
  assert.equal(resolveInvite("1", FAKE), FAKE)
  assert.equal(resolveInvite("  ZZZZ9999 ", FAKE), "ZZZZ9999")
  assert.equal(resolveInvite(undefined, ""), "")
  // 前端可能传数字
  assert.equal(resolveInvite(0, FAKE), FAKE)
  assert.equal(resolveInvite(1, FAKE), FAKE)
})

test("inviteHint：灰色字要说清「这是邀请人的码」和「留空会怎样」", () => {
  assert.match(inviteHint(FAKE), /当前默认码：ABCD1234/)
  assert.match(inviteHint(FAKE), /输入 1/)
  assert.match(inviteHint(""), /邀请人/)
  assert.match(inviteHint(""), /留空/)
  // 「不带码」是一个被记住的状态，提示里必须说清楚
  assert.match(inviteHint(INVITE_NONE), /不带邀请码/)
})

test("pickInvite：默认 → 自动 → 首选 → 不带码，四档语义", () => {
  // 空 / 0 / 1 → 沿用当前（没有当前时由调用方给默认码）
  assert.equal(pickInvite("", FAKE), FAKE)
  assert.equal(pickInvite("0", FAKE), FAKE)
  assert.equal(pickInvite("1", FAKE), FAKE)
  // 新码：去空格 + 转大写（本站的码是 8 位大写字母数字）
  assert.equal(pickInvite("  abcd1234 ", FAKE), FAKE)
  assert.equal(pickInvite("zzzz9999", FAKE), "ZZZZ9999")
  // 显式不带码：- / none（大小写都认）
  assert.equal(pickInvite("-", FAKE), INVITE_NONE)
  assert.equal(pickInvite("NONE", FAKE), INVITE_NONE)
  assert.equal(pickInvite("", INVITE_NONE), INVITE_NONE, "「不带」要被沿用，不能悄悄恢复成默认码")
})

test("createInviteStore：写读、原子、空码不写、读失败不抛", () => {
  const store = createInviteStore("zzopc")
  assert.equal(store.read(), "")
  store.write(FAKE, { source: "chosen" })
  assert.equal(store.read(), FAKE)
  // 空码不覆盖已有的
  store.write("", { source: "x" })
  assert.equal(store.read(), FAKE)
})

test("createInviteStore：换码必须一起换 extra，同码才继承", () => {
  const store = createInviteStore("zzopc-extra")
  store.write("CODE1", { extra: { sId: "sid-1" } })
  assert.equal(store.readExtra("sId"), "sid-1")
  // 换码且不给新参数 → 旧参数必须丢掉（拿旧参数配新码 = 邀请不生效）
  store.write("CODE2", { extra: {} })
  assert.equal(store.readExtra("sId"), "")
  // 同码重写且不给参数 → 继承（幂等）
  store.write("CODE2", { extra: { sId: "sid-2" } })
  store.write("CODE2", { extra: {} })
  assert.equal(store.readExtra("sId"), "sid-2")
})

test("inviteRegisterUrl：带码 → 注册页带 ?invite=；空码 → 普通注册页", () => {
  assert.equal(inviteRegisterUrl(FAKE), `https://opc.fiime.cn/register?invite=${FAKE}`)
  // 站点自己给了 url 就用它（形状可能变）
  assert.equal(inviteRegisterUrl(FAKE, "https://opc.fiime.cn/register?invite=OTHER"), "https://opc.fiime.cn/register?invite=OTHER")
  assert.equal(inviteRegisterUrl(""), "https://opc.fiime.cn/zh-cn/register")
  // 码里带特殊字符要编码，不能拼出半截 URL
  assert.match(inviteRegisterUrl("A B&c"), /\?invite=A%20B%26c$/)
})

test("makeInviteMethod：先问邀请码，问完返回 null，authorize 复用主登录", async () => {
  const store = createInviteStore("zzopc-method")
  const mainCalls = []
  const mainMethod = {
    async authorize(inputs) {
      mainCalls.push(inputs)
      // 主登录读的是「当前策略」，这正是 authorize 必须先 save 的原因
      return { url: inviteRegisterUrl(store.read()), method: "auto", callback: async () => ({ type: "success" }) }
    },
  }
  const m = makeInviteMethod({
    label: "邀请码注册",
    mainMethod,
    followUps: [],
    pick: (inputs) => resolveInvite(inputs.invite, store.read()).trim().toUpperCase(),
    save: (code) => store.write(code, { source: "chosen" }),
    current: () => store.read(),
  })

  assert.equal(m.type, "oauth")
  assert.ok(Array.isArray(await m.prompts), "面板列表要靠 prompts 显示第一个问题")
  assert.equal((await m.ask({})).key, "invite")
  assert.equal(await m.ask({ invite: FAKE }), null)

  // 本次填的码 → 存下来 → 主登录拼出的 URL 必须带着它
  const out = await m.authorize({ invite: "  abcd1234 " })
  assert.equal(store.read(), FAKE, "存的应该是归一化后的大写码")
  assert.equal(out.url, `https://opc.fiime.cn/register?invite=${FAKE}`)
  assert.deepEqual(mainCalls, [{ invite: "  abcd1234 " }], "authorize 必须把完整 inputs 交给主登录")

  // 输入 1 → 沿用上一次的码，不会被清空
  await m.authorize({ invite: "1" })
  assert.equal(store.read(), FAKE)
})

test("makeInviteMethod：留空不写策略，主登录走普通注册页", async () => {
  const store = createInviteStore("zzopc-empty")
  const m = makeInviteMethod({
    label: "邀请码注册",
    mainMethod: {
      async authorize() {
        return { url: inviteRegisterUrl(store.read()), method: "auto" }
      },
    },
    followUps: [],
    pick: (inputs) => resolveInvite(inputs.invite, store.read()).trim().toUpperCase(),
    save: (code) => store.write(code, { source: "chosen" }),
  })

  const out = await m.authorize({ invite: "" })
  assert.equal(store.read(), "", "留空不能凭空写一个码")
  assert.equal(out.url, "https://opc.fiime.cn/zh-cn/register")
})
