// tests/browser-login.test.mjs —— 隔离浏览器登录的纯函数语义
//
// 真的开 GUI 浏览器跑不进单测，所以这里锁的是「决定什么时候收工」的那部分：
// selectCookies 只挑指定的名字、readyToFinish 是「且」不是「或」、pollCookies 会超时。
// 这三条写反的后果都是「窗口里明明登录了，插件却说没抓到」。

import test from "node:test"
import assert from "node:assert/strict"

import { pollCookies, readyToFinish, selectCookies } from "../src/browser-login.mjs"
import { REQUIRED_COOKIES, LOGIN_URL, loginViaBrowser } from "../src/web-login.mjs"

const cookies = [
  { name: "ANASID", value: "sid-value" },
  { name: "opc_sid", value: "opc-value" },
  { name: "other", value: "nope" },
]

test("selectCookies 只挑指定的名字，空值不算", () => {
  const { header, found } = selectCookies(cookies, REQUIRED_COOKIES)
  assert.equal(header, "ANASID=sid-value; opc_sid=opc-value")
  assert.deepEqual(Object.keys(found).sort(), ["ANASID", "opc_sid"])

  const withEmpty = selectCookies([...cookies, { name: "ANACCOUNT", value: "" }], ["ANACCOUNT"])
  assert.equal(withEmpty.header, "")
})

test("readyToFinish：cookie 齐了但 waitFor 说不行，就还没完", async () => {
  const found = { ANASID: "a", opc_sid: "b" }
  assert.equal(await readyToFinish({ cookieNames: REQUIRED_COOKIES, header: "a; b", found }), true)
  assert.equal(
    await readyToFinish({ cookieNames: REQUIRED_COOKIES, header: "a; b", found, waitFor: () => false }),
    false,
  )
  assert.equal(
    await readyToFinish({ cookieNames: REQUIRED_COOKIES, header: "a; b", found, waitFor: async () => true }),
    true,
  )
  // 缺一个就不算齐
  assert.equal(await readyToFinish({ cookieNames: REQUIRED_COOKIES, header: "a", found: { ANASID: "a" } }), false)
})

test("pollCookies 超时会抛，而不是无限等", async () => {
  await assert.rejects(
    pollCookies({
      readCookies: async () => [],
      cookieNames: REQUIRED_COOKIES,
      deadline: Date.now() - 1,
      stepMs: 10,
    }),
    /超时|没有拿到/,
  )
})

test("pollCookies 在拿到全部 cookie 后返回 header", async () => {
  const result = await pollCookies({
    readCookies: async () => cookies,
    cookieNames: REQUIRED_COOKIES,
    deadline: Date.now() + 5_000,
    stepMs: 10,
  })
  assert.equal(result.cookie, "ANASID=sid-value; opc_sid=opc-value")
})

test("loginViaBrowser 找不到浏览器时给出可执行的提示，而不是抛", async () => {
  // ⚠ 用注入的 find 而不是 browser: null —— 后者会回落到真实的 findBrowser()，
  //   在装了 Chrome 的机器上会真的开出窗口（实测卡住过一次）。
  const result = await loginViaBrowser({ find: () => null })
  assert.equal(result.type, "failed")
  assert.match(result.error, /Chromium|粘贴/)
})

test("登录页与必需 cookie 常量是站点实测值", () => {
  assert.equal(LOGIN_URL, "https://opc.fiime.cn/zh-cn/login")
  assert.deepEqual(REQUIRED_COOKIES, ["ANASID", "opc_sid"])
})
