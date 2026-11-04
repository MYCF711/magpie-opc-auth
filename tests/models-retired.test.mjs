// tests/models-retired.test.mjs —— 目录三态 + 「下线的模型不许再列出来」
//
// 来历（2026-11-04 真实故障）：站点把 `deepseek-v4-1-flash-1017` 从目录里删了，
// 但 magpie 的 `providers.json` 里用户选过的那一条不会自己消失，静态表又会把它列回来
// ⇒ 用户每次选中它都撞一次 404 网页。这个文件锁两件事：
//   ① 静态表里不许再出现已经下线的 id（防「按老清单加回来」）
//   ② retired 集合里的 id，无论来自上游目录还是用户配置，都不列

import test from "node:test"
import assert from "node:assert/strict"

import { buildModels, keepUnknownModels, specFromRemote, staticModels } from "../src/models.mjs"
import { DEFAULT_MODEL, MODEL_SPECS } from "../src/context.mjs"

const RETIRED = "deepseek-v4-1-flash-1017"

test("静态表（未登录兜底）不再包含已下线的模型", () => {
  const models = staticModels()
  assert.ok(Object.keys(models).length > 0, "铁律 1：静态表必须有内容")
  assert.equal(models[RETIRED], undefined, "下线模型不许回到静态表")
  assert.ok(!MODEL_SPECS.some((m) => m.id === RETIRED))
})

test("静态表里的每条都能被 specFromRemote 认成 chat 模型（形状自洽）", () => {
  for (const spec of MODEL_SPECS) {
    const remote = specFromRemote({ id: spec.id, type: "text", modalities: ["text"], capabilities: [] })
    assert.ok(remote, `${spec.id} 应当能解析`)
    assert.equal(remote.id, spec.id)
  }
})

test("默认模型仍在表里（装上去就能选）", () => {
  assert.ok(staticModels()[DEFAULT_MODEL], `默认模型 ${DEFAULT_MODEL} 必须在静态表里`)
})

test("上游目录里出现 retired 的 id → 不列", () => {
  const list = [
    { id: "deepseek-v4-flash", type: "text", modalities: ["text"], capabilities: ["tool_calling"] },
    { id: RETIRED, type: "text", modalities: ["text"], capabilities: ["tool_calling"] },
  ]
  const models = buildModels({ id: "opc", models: {} }, { list, retired: new Set([RETIRED]) })
  assert.ok(models["deepseek-v4-flash"])
  assert.equal(models[RETIRED], undefined)
})

test("用户配置里还留着 retired 的 id → 不列（providers.json 不会自动清理）", () => {
  const provider = {
    id: "opc",
    models: {
      [RETIRED]: { id: RETIRED, name: "老模型" },
      "my-own-model": { id: "my-own-model", name: "我自己加的" },
    },
  }
  const list = [{ id: "deepseek-v4-flash", type: "text", modalities: ["text"], capabilities: [] }]
  const models = buildModels(provider, { list, retired: new Set([RETIRED]) })
  assert.equal(models[RETIRED], undefined, "下线的必须消失")
  assert.ok(models["my-own-model"], "用户自己加的（站点目录里没有但没被判定下线）要保留")
})

test("目录拉不到时仍走静态表，且不把 retired 的配置项加回来", () => {
  const provider = { id: "opc", models: { [RETIRED]: { id: RETIRED } } }
  const models = buildModels(provider, { list: null, retired: new Set([RETIRED]) })
  assert.ok(Object.keys(models).length > 0)
  assert.equal(models[RETIRED], undefined)
})

test("keepUnknownModels 兼容老调用（不传 retired 时保留用户模型）", () => {
  const provider = { models: { "x-1": { id: "x-1" } } }
  assert.deepEqual(Object.keys(keepUnknownModels(provider, {})), ["x-1"])
})
