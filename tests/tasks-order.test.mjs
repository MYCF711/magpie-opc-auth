// tests/tasks-order.test.mjs —— 「先领奖励，再清理模板内容」的顺序锁
//
// 这个顺序反了不会报错，只会让任务变成「未完成」，用户当天少领 1000 万。
// 所以用一个假站点把整条链路跑一遍，断言 DELETE 发生在 claim 之后。

import test from "node:test"
import assert from "node:assert/strict"

import { runDailyTasks } from "../src/tasks.mjs"

function mockSite({ projectTask = "do" } = {}) {
  const calls = []
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } })

  const tasks = [
    { id: "message_wall", enabled: true, quotaAvailable: true, claimed: true, completed: true },
    { id: "plaza_post", enabled: true, quotaAvailable: true, claimed: true, completed: true },
    {
      id: "project_publish",
      enabled: true,
      quotaAvailable: true,
      claimed: false,
      completed: projectTask === "claim",
      claimable: projectTask === "claim",
    },
    { id: "requirement_publish", enabled: true, quotaAvailable: true, claimed: false, completed: false },
  ]

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    const method = init.method || "GET"
    calls.push({ url: u, method })

    if (u.endsWith("/api/model-service") && method === "GET") {
      return json({ services: {}, wallet: {}, usage: {}, benefits: { tasks } })
    }
    if (u.endsWith("/api/csrf-token")) return json({ token: "csrf" })
    if (u.endsWith("/api/auth/me")) return json({ user: { realnameVerified: true, verification: { identity: { status: "approved" } } } })
    if (u.endsWith("/api/plaza/upload")) return json({ urls: ["/uploads/plaza/cover.png"] })
    if (u.endsWith("/api/projects") && method === "POST") return json({ project: { id: "p_test" } })
    if (u.includes("/benefits/claim") && method === "POST") return json({ reward: 10_000_000, dashboard: {} })
    if (u.includes("/api/projects/p_test") && method === "DELETE") return json({ ok: true })
    return json({ error: `unexpected ${method} ${u}` }, 500)
  }

  return calls
}

const COOKIE = "ANASID=t;opc_sid=t"

test("项目任务：领完 1000 万之后，模板项目被删掉", async () => {
  const calls = mockSite({ projectTask: "do" })
  const result = await runDailyTasks({ cookie: COOKIE, options: {}, signature: "t", accountKey: "k1" })

  const project = result.results.find((r) => r.id === "project_publish")
  assert.equal(project.status, "claimed")
  assert.equal(project.reward, 10_000_000)
  assert.equal(project.cleaned, true)

  const claimAt = calls.findIndex((c) => c.url.includes("/benefits/claim"))
  const deleteAt = calls.findIndex((c) => c.method === "DELETE" && c.url.includes("/api/projects/p_test"))
  assert.ok(claimAt >= 0, "必须领取")
  assert.ok(deleteAt >= 0, "必须删除模板项目")
  assert.ok(deleteAt > claimAt, "删除必须在领取之后 —— 反过来就领不到了")
})

test("已完成可领的项目：只领取，不重发、不删（那是别人/上次的内容）", async () => {
  const calls = mockSite({ projectTask: "claim" })
  const result = await runDailyTasks({ cookie: COOKIE, options: {}, signature: "t", accountKey: "k2" })

  const project = result.results.find((r) => r.id === "project_publish")
  assert.equal(project.status, "claimed")
  assert.equal(project.publishedId, undefined)
  assert.equal(calls.some((c) => c.method === "POST" && c.url.endsWith("/api/projects")), false)
  assert.equal(calls.some((c) => c.method === "DELETE"), false)
})

test("keepPublished: true 时保留模板项目", async () => {
  const calls = mockSite({ projectTask: "do" })
  await runDailyTasks({ cookie: COOKIE, options: { keepPublished: true }, accountKey: "k3" })
  assert.equal(calls.some((c) => c.method === "DELETE"), false)
})

test.after(() => {
  delete globalThis.fetch
})
