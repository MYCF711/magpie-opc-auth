// tests/chat-fetch.test.mjs —— 聊天通道的 fetch 包装
//
// 全部离线：globalThis.fetch 换成假的，只验「上游回网页时插件产出什么」。
//
// 这条规则的来历（2026-11-04 真实故障）：站点把 `deepseek-v4-1-flash-1017` 从模型目录里
// 删掉之后，请求它时模型面回的是 **404 + 站点 SPA 的 HTML 落地页**。插件不拦的话，
// magpie 只能说「404 Not Found: a web page, not an API reply」+ 一串营销页标题，
// 用户根本看不出该「换个模型」还是「重新登录」。

import test from "node:test"
import assert from "node:assert/strict"

import { catalogIds, createChatFetch, modelOfBody, pageReplyError } from "../src/chat.mjs"
import { USER_AGENT } from "../src/context.mjs"
import { errorText } from "../src/http.mjs"

const HTML_404 = '<!DOCTYPE html><html lang="zh-CN"><head><title>OPC一人公司是什么意思？注册、运营与创业指南-FiimeOPC社区</title></head><body>…</body></html>'
const HTML_401 = '<!DOCTYPE html><html><head><title>登录 - FiimeOPC</title></head><body>login</body></html>'

/** 装一次全局 fetch：返回固定响应，并记下真实发出去的请求 */
function stubFetch(response, calls = []) {
  const previous = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: typeof input === "string" ? input : input?.url, init })
    return response
  }
  return () => {
    globalThis.fetch = previous
  }
}

const html = (status, body = HTML_404) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } })

test("上游 404 + 网页 → 404 model_not_found，且文案点名是哪个模型", async () => {
  const restore = stubFetch(html(404))
  try {
    const chatFetch = createChatFetch({ catalog: new Set(["deepseek-v4-flash"]) })
    const res = await chatFetch("https://opc.fiime.cn/api/model-service/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "deepseek-v4-1-flash-1017", messages: [] }),
    })
    assert.equal(res.status, 404)
    const body = await res.json()
    assert.equal(body.error.code, "model_not_found", "404 只搁置这个模型，不许标账号")
    assert.equal(body.error.status, 404)
    assert.match(body.error.message, /deepseek-v4-1-flash-1017/)
    assert.match(body.error.message, /下线|模型目录/)
    // 宿主看到的是 JSON，而不是营销页标题
    assert.ok(!body.error.message.includes("<!DOCTYPE"))
  } finally {
    restore()
  }
})

test("上游 404 + 网页，且模型还在目录里 → 不记「下线」（抖动不能钉死好模型）", async () => {
  const gone = []
  const restore = stubFetch(html(404))
  try {
    const chatFetch = createChatFetch({ catalog: new Set(["deepseek-v4-flash"]), onModelGone: (m) => gone.push(m) })
    await chatFetch("https://opc.fiime.cn/api/model-service/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "deepseek-v4-flash" }),
    })
    assert.deepEqual(gone, [])
  } finally {
    restore()
  }
})

test("上游 404 + 网页，模型不在目录里 → 记一次「下线」", async () => {
  const gone = []
  const restore = stubFetch(html(404))
  try {
    const chatFetch = createChatFetch({ catalog: () => new Set(["deepseek-v4-flash"]), onModelGone: (m) => gone.push(m) })
    await chatFetch("https://opc.fiime.cn/api/model-service/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "deepseek-v4-1-flash-1017" }),
    })
    assert.deepEqual(gone, ["deepseek-v4-1-flash-1017"])
  } finally {
    restore()
  }
})

test("目录从没拉过（空集合）→ 不记「下线」，但照样报 model_not_found", async () => {
  const gone = []
  const restore = stubFetch(html(404))
  try {
    const chatFetch = createChatFetch({ catalog: new Set(), onModelGone: (m) => gone.push(m) })
    const res = await chatFetch("https://opc.fiime.cn/api/model-service/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "whatever" }),
    })
    assert.equal(res.status, 404)
    assert.deepEqual(gone, [])
  } finally {
    restore()
  }
})

test("上游 401 + 网页 → 401 sign_in_required，文案要求重新登录", async () => {
  const restore = stubFetch(html(401, HTML_401))
  try {
    const chatFetch = createChatFetch({ catalog: new Set() })
    const res = await chatFetch("https://opc.fiime.cn/api/model-service/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "deepseek-v4-flash" }),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error.code, "sign_in_required")
    assert.match(body.error.message, /重新登录/)
    assert.match(body.error.message, /登录 - FiimeOPC/)
  } finally {
    restore()
  }
})

test("上游 200 + 网页（地址写错会这样）→ 502 upstream_error，不许当成功", async () => {
  const restore = stubFetch(html(200))
  try {
    const chatFetch = createChatFetch({ catalog: new Set() })
    const res = await chatFetch("https://opc.fiime.cn/api/model-service/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "deepseek-v4-flash" }),
    })
    assert.equal(res.status, 502)
    const body = await res.json()
    assert.equal(body.error.code, "upstream_error")
  } finally {
    restore()
  }
})

test("JSON 响应原样透传（同一个 Response，body 不被读掉）", async () => {
  const original = new Response(JSON.stringify({ id: "chatcmpl-1", choices: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
  const restore = stubFetch(original)
  try {
    const chatFetch = createChatFetch({ catalog: new Set() })
    const res = await chatFetch("https://opc.fiime.cn/api/model-service/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "deepseek-v4-flash" }),
    })
    assert.equal(res, original, "非网页响应必须原样交回宿主")
    assert.equal((await res.json()).id, "chatcmpl-1")
  } finally {
    restore()
  }
})

test("SSE 流原样透传（包装不许读流 —— 坑 8）", async () => {
  const sse = new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
  const restore = stubFetch(sse)
  try {
    const chatFetch = createChatFetch({ catalog: new Set() })
    const res = await chatFetch("https://opc.fiime.cn/api/model-service/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "deepseek-v4-flash", stream: true }),
    })
    assert.equal(res, sse)
    assert.match(await res.text(), /delta/)
  } finally {
    restore()
  }
})

test("包装一定把官方网页 UA 打上去（AGENTS 坑 32）", async () => {
  const calls = []
  const restore = stubFetch(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }), calls)
  try {
    const chatFetch = createChatFetch({ catalog: new Set() })
    await chatFetch("https://opc.fiime.cn/api/model-service/v1/chat/completions", {
      method: "POST",
      headers: { "user-agent": "magpie/0.1.2901", authorization: "Bearer opc_sk_test" },
      body: JSON.stringify({ model: "deepseek-v4-flash" }),
    })
    const sent = new Headers(calls[0].init.headers)
    assert.equal(sent.get("user-agent"), USER_AGENT)
    assert.equal(sent.get("authorization"), "Bearer opc_sk_test", "其余头不许被吃掉")
  } finally {
    restore()
  }
})

test("modelOfBody：字符串 / bytes / 对象 / 乱码", () => {
  assert.equal(modelOfBody(JSON.stringify({ model: "a" })), "a")
  assert.equal(modelOfBody(new TextEncoder().encode(JSON.stringify({ model: "b" }))), "b")
  assert.equal(modelOfBody({ model: "c" }), "c")
  assert.equal(modelOfBody("not json"), "")
  assert.equal(modelOfBody(undefined), "")
  assert.equal(modelOfBody(""), "")
})

test("pageReplyError 的三种形状都带 status + code + 人话", () => {
  for (const status of [404, 401, 418]) {
    const res = pageReplyError({ status, text: HTML_404, model: "m1" })
    assert.ok([404, 401, 502].includes(res.status))
    const body = errorText(res) // 只是确认 errorText 对 JSON 有效
    assert.equal(typeof body, "string")
  }
  const notFound = pageReplyError({ status: 404, text: HTML_404, model: "m1" })
  assert.equal(notFound.status, 404)
  const pageHtml = pageReplyError({ status: 200, text: HTML_404 })
  assert.equal(pageHtml.status, 502)
})

// ── 目录快照 ─────────────────────────────────────────────────────────
//
// catalogIds 读 `~/.cache/magpie/plugin-store-snapshot-opc.json`。测试机器上那个文件
// 可能有内容、也可能没有，所以这里只断言「形状正确」：要么空集合，要么都是非空字符串。

test("catalogIds 永远返回 Set（读不到缓存就是空集合，不抛）", () => {
  const ids = catalogIds("opc-test-not-exist")
  assert.ok(ids instanceof Set)
  for (const id of ids) assert.equal(typeof id, "string")
  assert.equal(ids.size, 0, "不存在的 siteId 必须读成空集合")
})
