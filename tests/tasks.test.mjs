// tests/tasks.test.mjs —— 「只在能换到奖励时才动手」的语义锁
//
// 这个插件最容易犯的错不是崩，而是**白花 Token**：
// 任务已经领过了还去发帖、内容还在审核就重发、名额用完还去建内容。
// gateTask() 是唯一的闸门，所以把它的每个分支都钉死。

import test from "node:test"
import assert from "node:assert/strict"

import { gateTask } from "../src/tasks.mjs"
import { pickNote, pickPost, pickProject, NOTES, POSTS, PROJECTS } from "../src/texts.mjs"
import { COVER_BASE64 } from "../src/cover.mjs"

const base = { id: "message_wall", enabled: true, quotaAvailable: true }

test("已领取 → done（不重做）", () => {
  assert.equal(gateTask({ ...base, claimed: true, completed: true, claimable: false }), "done")
})

test("已完成且可领 → claim（只领，不重发）", () => {
  assert.equal(gateTask({ ...base, completed: true, claimable: true }), "claim")
})

test("已完成但不可领（审核中）→ skip", () => {
  assert.equal(gateTask({ ...base, completed: true, claimable: false }), "skip")
})

test("名额用尽 / 没有名额 / 活动关闭 → skip", () => {
  assert.equal(gateTask({ ...base, completed: false, limitReached: true }), "skip")
  assert.equal(gateTask({ ...base, completed: false, quotaAvailable: false }), "skip")
  assert.equal(gateTask({ ...base, completed: false, enabled: false }), "skip")
})

test("没做过且有名额 → 才允许动手（do）", () => {
  assert.equal(gateTask({ ...base, completed: false, claimed: false }), "do")
})

test("缺字段的脏数据不会误判成 do", () => {
  assert.equal(gateTask(null), "skip")
  assert.equal(gateTask({}), "do") // 站点确实会给 enabled/quotaAvailable 缺省，保守起见按 do 处理
})

test("内置文案池非空，且寄语满足 20-160 字", () => {
  assert.ok(NOTES.length >= 7)
  for (const note of NOTES) {
    const n = [...note].length
    assert.ok(n >= 20 && n <= 160, `寄语长度 ${n} 越界：${note}`)
  }
  assert.ok(POSTS.length >= 3)
  for (const post of POSTS) {
    assert.ok(post.title && post.content)
  }
  assert.ok(PROJECTS.length >= 1)
  for (const project of PROJECTS) {
    assert.ok(project.title && project.summary && project.content && project.tags?.length)
  }
})

test("pick* 每次都返回池子里的合法项", () => {
  assert.ok(NOTES.includes(pickNote(0)))
  assert.ok(POSTS.some((p) => p.title === pickPost(1).title))
  assert.ok(PROJECTS.some((p) => p.title === pickProject(2).title))
})

test("内置封面是一张能解码的 PNG", () => {
  const buf = Buffer.from(COVER_BASE64, "base64")
  assert.ok(buf.length > 1000, "封面太像占位符了")
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
})
