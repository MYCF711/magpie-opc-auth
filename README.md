# 一人公司社区 FiimeOPC · magpie 供应商插件

把 **FiimeOPC（opc.fiime.cn）** 的账号接进 magpie：粘一次浏览器 Cookie，
卡片上就有 **Token 余额**、**每日用量 / 每日上限**、**今日任务进度**，
同时插件会用这条 Cookie 自动建一把 API Key —— 站点自己的 **17 个聊天模型**（DeepSeek V4、GLM 5.2、Kimi K3 等）
当场能在 agent 里跑。每日签到（寄语墙 +1000 万 Token）也在插件里，一条命令领完。

```
额度      Token 钱包（用一点少一点，不会每日重置）+ 每日消耗上限 1 亿（北京时间 0 点重置）
模型      17 个聊天模型（站点 /v1/models 实测 22 条，其中 5 条是图像/视频生成）
登录方式  2 种（粘贴浏览器 Cookie / 粘贴 API Key��
跑模型要  一把 API Key（`opc_sk_…`）——「粘贴 Cookie」那条路插件会自己换一把
签到      寄语墙任务：每天 1 条 ≥20 字寄语，+1000 万 Token（累计上限 30 次）
```

> ⚠ **这个站点的两个面是两套鉴权，缺一条就有一半功能是空的。**
> 模型面 `/api/model-service/v1/*` 只认 `Authorization: Bearer opc_sk_…`；
> 网页 cookie 打过去回 `{"error":{"type":"invalid_api_key"}}`。
> 网页面 `/api/model-service`、`/api/auth/me`、签到只认 Cookie；API Key 打过去是 401。
> 所以插件的推荐用法是**粘 Cookie**：额度、模型通道、签到一次齐。

---

## 一次到位，或者两步走

**省事的那条：登录时选「粘贴浏览器 Cookie」。**
浏览器打开 opc.fiime.cn 并登录 → F12 → Application → Cookies → 复制 `ANASID`、`opc_sid`、`ANACCOUNT`
拼成 `ANASID=…; opc_sid=…; ANACCOUNT=…` 粘进去。插件会：

1. 用 Cookie 读额度（余额 / 今日用量 / 任务进度）
2. 用 Cookie 在站点上创建一把 API Key（`POST /api/model-service/keys`）并落盘到 `~/.cache/magpie/`
3. 把这条 key 交给模型通道

**只想跑模型**：登录时选「粘贴 API Key」，从 <https://opc.fiime.cn/zh-cn/model-service> 的
「创建 API Key」拿一把 `opc_sk_…` 粘进去。额度卡片会明确说「这条凭据只有 API Key，查不了额度」，
不会假装 0。

## 功能

- **Token 余额上卡片**：钱包型窗口显示 `wallet.balance`（实测 2000 万起）。
  余额不会每日重置 —— 重置的只有「今天还能花多少」。
- **今日用量 / 每日上限**：`usage.usedToday` / `usage.dailyLimit`（实测上限 1 亿 Token/天），
  按北京时间 0 点重置；窗口带 `resetsAt`，卡片上能看出什么时候回血。
- **今日任务进度**：4 个每日任务（寄语墙 / 搭子广场发帖 / 资源中心项目 / 需求中心）
  领了几个、还剩哪些，一行文字写在卡片上。
- **17 个聊天模型，能力照模型自己的声明**：`image` / `toolcall` 来自站点 `/v1/models` 的
  `modalities` 与 `capabilities`，不是猜的；`deepseek-v4-pro` 这类能收图的不会被标成纯文本，
  `glm-5-2` 这类纯文本的也不会被误标成能收图。
- **每日签到**：`message_wall` 任务 —— 当天没领就先发一条寄语（内置 8 条中性文案按日期轮换），
  再领 1000 万；已经有可领奖励时直接领，不重复发。
- **上下文窗口不猜**：站点不返回上下文长度，插件只在宿主缓存里查得到时才写，
  查不到就省略（猜大了 agent 会以为放得下，猜小了浪费容量）。
- **三态降级**：`/v1/models` 整个失败 → 退回静态表；单条模型缺字段 → 不列；
  登录失效 → `signIn: "expired"`，让 magpie 提示重新登录。

## 模型

站点 `/api/model-service/v1/models` 实测返回 22 条：17 条 `type: "text"`（插件列这些），
5 条图像 / 视频生成模型（`opc-image-*`、`opc-video-*`、`sensenova-u1-fast`，插件不列进 chat）。

| 模型 | 能收图 | 工具 | 站点倍率 |
|---|---|---|---|
| `deepseek-v4-1-flash-1017` | ✓ | ✓ | 2x |
| `deepseek-v4-pro` | ✓ | ✓ | 5x |
| `deepseek-v4-flash` | ✓ | ✓ | 3x |
| `deepseek-v4-flash-0731` | ✓ | ✓ | 2x |
| `kimi-k3` | ✓ | ✓ | 5x |
| `mixmodel` | ✓ | ✓ | 10x |
| `sensenova-6-8-flash-lite` | ✓ | ✓ | 5x |
| `glm-5-2` / `glm-5-2-l` | ✗ | ✓ | 2x |
| `qwen3-8-27b` | ✗ | ✓ | 2x |
| `dots-3-note-preview` | ✗ | ✓ | 3x |
| `north-mini-code` | ✗ | ✓ | 1x |
| `laguna-xs-2-1` | ✗ | ✓ | 1x |
| `nemotron-3-ultra-550b-a55b` | ✗ | ✓ | — |
| `space-bunny-alpha` | ✗ | ✓ | — |
| `opc-txt-v1` / `opc-txt-v2` | ✗ | ✓ | 2x |

「倍率」是站点自己的 `rateMultiplier`：同一个问题用 `mixmodel` 消耗的 Token 是 `north-mini-code` 的 10 倍。
插件不据此改任何计费字段（`cost` 一律写 0），只把它写进模型的 `rate` 供参考。

## 签到

站点把「签到」做成了一个每日任务：**寄语墙发送寄语**（`message_wall`）。

- 要求：一条 20–160 字的寄语，审核通过后发布
- 奖励：`+10,000,000` Token（固定值）
- 频率：每天 1 次，北京时间 0 点重置
- 上限：累计 **30 次**（`maxClaims: 30`）—— 是总量，不是每日
- 实测：发布后 `completed` 与 `claimable` 立即为真，可以马上领；
  同一天第二次 `POST /benefits/claim` 返回 `409 already_claimed`

另外三个任务（发帖 / 项目 / 需求）同样每天各一次，插件只在卡片上显示进度，
不替你发帖 —— 那些是公开内容，交给用户自己决定。`requirement_publish` 还需要实名认证，
没通过时站点会直接回 `{"error":"请先完成实名认证"}`。

## 安装

在 magpie 里：**插件 → 添加插件 → 填仓库地址**。

```bash
magpie plugin add github:MYCF711/magpie-opc-auth
magpie plugin login opc      # 选「粘贴浏览器 Cookie」
magpie quota                 # 看 Token 余额与今日用量
magpie provider test opc     # 发一个很小的请求验证通道
magpie plugin checkin opc    # 手动签到一次
```

装完在应用的 **供应商** 页能看到 `一人公司社区 FiimeOPC` 这一行。

### 选项（可选，全部有默认值）

```json
{
  "cookie": "",                    // 不通过登录界面时，直接把 Cookie 写在这里
  "apiKey": "",                    // 直接用一把已有的 API Key
  "autoKey": true,                 // Cookie 登录时自动创建/复用 API Key
  "keyName": "magpie-opc-auth",    // 自动创建的 key 的名字
  "checkinTask": "message_wall",   // 签到用哪个任务
  "checkinText": ""                // 签到文案；留空用内置池按日期轮换
}
```

多数人不需要填任何一项。

## 常见问题

**1. 为什么模型能聊，额度条却是空的？**
你粘的是 API Key。额度接口只认浏览器 Cookie，再登一次「粘贴浏览器 Cookie」就好；
两条凭据可以同时挂在同一个供应商下，卡片会优先显示能查额度的那条。

**2. 为什么额度正常，模型列表却报「登录已失效」？**
反过来了：你只有 Cookie，而插件创建 API Key 失败（比如站点改了这个接口，或者达到 5 把上限）。
到 <https://opc.fiime.cn/zh-cn/model-service> 的「创建 API Key」手动建一把，再粘进来。

**3. Cookie 多久过期？**
站点给的 `opc_sid` 有效期 7 天、`ANASID` 是会话级；服务端**不滑动续期**（响应里没有 `Set-Cookie`）。
过期后卡片会写「登录已失效（Cookie 过期）」，重新复制一次即可。

**4. 签到说「今天已领取」？**
站点 0 点按北京时间重置。`done` = 今天已经领过，明天再来。

**5. 签到时说「审核未通过」？**
站点对寄语有一条自动审核（返回 `analysis.status` 与 `reason`）。插件不重试被拒的内容 ——
换一条文案再来，或者在选项里写死 `checkinText`。

**6. 为什么卡片上有个「今日任务」却没有进度条？**
那是纯文字窗口：任务进度没有「上限」可算占比。它不参与智能路由（`textOnly: true`），
路由只看 Token 余额窗口。

**7. 这些模型倍率会不会影响卡片上的余额？**
不会。余额是站点自己扣的，插件只读。倍率只影响同一句话在不同模型上扣多少。

## 参考源

| 来源 | 用了什么 |
|---|---|
| FiimeOPC 站点前端（`/assets/ModelService-*.js`、`MessageWall-*.js`） | 接口路径、请求体字段、claim 的 `{task}` 形状、寄语 `check` → `publish` 两段流程 |
| 真实账号实测（2026-11-03） | `wallet` / `usage` / `benefits` 字段、模型 22 条与能力、`opc_sk_` 前缀、cookie 7 天、签到 30 次上限、409 已领取 |
| [`MYCF711/magpie-plugin-scaffold`](https://github.com/MYCF711/magpie-plugin-scaffold) | 仓库结构、九钩子装配、`src/quota.mjs` / `usage-cache.mjs` / `model-context.mjs`、检查与打分脚本 |

实现细节、协议取证与「为什么这么写」在 [docs/internals.md](./docs/internals.md)。

## 许可

MIT。见 [LICENSE](./LICENSE) 与 [NOTICE.md](./NOTICE.md)。
本项目与 FiimeOPC 官方无关，是社区插件。

> 更新记录：[CHANGELOG.md](./CHANGELOG.md)
