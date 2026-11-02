# 实现细节与协议取证

这份文件回答「为什么这么写」。面向维护者，不是用户。

## 1. 账号与鉴权

| 面 | 前缀 | 鉴权 | 备注 |
|---|---|---|---|
| 网页 | `/api/*` | `Cookie: ANASID=…; opc_sid=…; ANACCOUNT=…` + `X-CSRF-Token` | 读额度、读账号、签到、建 key |
| 模型 | `/api/model-service/v1/*` | `Authorization: Bearer opc_sk_…` | 只有 `/models` 与 `/chat/completions` |

实测（2026-11-03，真实账号 `<ACCOUNT>`）：

```
GET /api/model-service/v1/models        带 Cookie  → 200 {"error":{"message":"缺少有效的 Bearer API Key","type":"invalid_api_key"}}
GET /api/model-service                  带 Key     → 401（网页面不认 Bearer）
GET /api/model-service/v1/models        带 Key     → 200 {"object":"list","data":[22 条]}
```

站点对 `User-Agent` 敏感：不带 UA 的请求会被判异常（`{"error":"请求异常，请稍后再试","requireCaptcha":true}`）。
所以 `src/api.mjs` 的所有请求都带 `user-agent: magpie-opc-auth/<version>` 与 `referer`。

## 2. 额度字段

`GET /api/model-service`（Cookie）返回：

```json
{
  "service": { "dailyTokenLimit": 100000000, "maxApiKeysPerUser": 5, "models": [...] },
  "wallet":  { "balance": 20000000, "totalEarned": 30000000, "totalSpent": 0 },
  "usage":   { "date": "2026-11-03", "usedToday": 3456, "dailyLimit": 100000000, "remainingToday": 99996544 },
  "keys":    [],
  "benefits": {
    "enabled": true,
    "day": "2026-11-03",
    "claimableTotal": 0,
    "claimedTotal": 10000000,
    "tasks": [
      { "id": "message_wall", "cadence": "daily", "reward": 10000000,
        "maxClaims": 30, "claimedCount": 1, "remainingClaims": 29,
        "completed": true, "claimable": false, "claimed": true }
    ]
  }
}
```

三种窗口的取舍：

- **Token 余额** → 钱包型 `usageWindow({ balance })`，可路由（quota.mjs 允许只有 balance 的窗口参与路由）
- **Token 余额（唯一的额度窗口）** → 钱包型 `usageWindow({ balance })`。
  实测字段：`{"balance":19998144,"totalEarned":20000000,"totalSpent":1856}`，卡片上就显示 `balance`。
  ⚠ **不要用 `usage.dailyLimit` 当分母**（1 亿/天）：那是「今天最多能花多少」，几乎永远用不完，
  写进卡片会让进度条永远满格；用户要的是「我还有多少」，不是「今天还没花完多少」。
  也不要用 `totalSpent / totalEarned` 做占比：`totalEarned` 每天领奖励都在涨，同一个余额会被显示成不同比例。
- **今日额度（条件出现）** → 只有 `usedToday >= dailyLimit` 时才加，文本窗口
  （`used: 100, aside: true, text: true`），内容 `已用尽 · N 小时后恢复`。未用尽时这一格完全不存在。
- **今日任务** → 文本窗口，只上卡片不参与路由

⚠ 文本窗口不能写 `textOnly: true`：`src/quota.mjs` 的 `usage()` 会对窗口做第二次构造，
而 `textOnly` 在第一次构造时被过滤掉，第二次就会因为「没有 used」而抛 `QuotaShapeError`。
用 `used: 0 + aside: true + text: true` 表达同一个意思，且幂等。

## 3. 模型目录

`GET /api/model-service/v1/models`（Bearer）每条：

```json
{ "id": "deepseek-v4-pro", "object": "model", "type": "text",
  "modalities": ["text","image"],
  "capabilities": ["text_generation","streaming","tool_calling","structured_output","image_understanding"],
  "enabled": true, "debug": false, "rateMultiplier": 5 }
```

映射规则（`src/models.mjs` 的 `specFromRemote`）：

| 站点字段 | magpie 字段 | 判据 |
|---|---|---|
| `type !== "text"` 或 id 以 `opc-image` / `opc-video` / `sensenova-u1` 开头 | 不列 | 生成模型不进 chat 列表 |
| `modalities` 含 `image` **且** `capabilities` 含 `image_understanding` | `capabilities.input.image = true` | 两个都要，只写一个会把纯文本模型标成能收图 |
| `capabilities` 含 `tool_calling` | `capabilities.toolcall = true` | |
| `rateMultiplier` | `rate` | 只作参考，不改 `cost` |
| 没有上下文字段 | **不写** `limit.context` | CHECKLIST A-8：上下文必须是实测值 |

`opc-txt-v1` 没有 `image_understanding`，`deepseek-v4-pro` 有 —— 所以两个模型在 magpie 里一个是纯文本、一个能收图。

## 4. 凭据种类

`src/credential.mjs` 的 `shapeKind()`：

- `opc_sk_` + 8 位以上 → `key`
- 出现 `ANASID=` / `opc_sid=` / `ANACCOUNT=` / `server_session_` → `cookie`
- 有 `=` 又有 `;` → `cookie`
- 其他 → `unknown`

判定顺序是 `metadata.kind` → `shapeKind()`。**不按登录方式猜**（AGENTS 坑 30）：
两种登录都是 `type: "api"`，值长什么样才是判据。

## 5. API Key 的创建与缓存

站点不会把已有 key 的 secret 再返回一次（`keys` 数组里只有 `masked`），
所以「Cookie 登录 + 自动换 key」必须在首次使用时**新建**一把：

```
POST /api/model-service/keys   {"name":"magpie-opc-auth"}
→ {"key":{"id":"msk_…","masked":"opc_sk_ab12••••2386"},"secret":"opc_sk_ab12…"}
```

secret 写进 `~/.cache/magpie/magpie-opc-auth__<账号指纹>.json`（文件名带账号 —— AGENTS 坑 16）。
`maxApiKeysPerUser: 5`，所以插件复用本地缓存，不在每次启动时新建。

## 6. 每日签到

```
GET  /api/model-service                          → benefits.tasks[message_wall]
POST /api/message-wall/check  {text,signature,color,anonymous,requestId}
   → {checkId, analysis:{status:"approved"|"pending"|"rejected", reason}, expiresAt}
POST /api/message-wall        {…, checkId}       → {note:{id,status:"approved"}}
POST /api/model-service/benefits/claim {"task":"message_wall"} → {reward:10000000, dashboard}
```

- `status` 必须是 `approved` 或 `pending` 才发布（`pending` = 仅自己可见，但任务仍会算完成）
- 同一天第二次 claim → `409 {"error":"该项福利今天已经领取","code":"already_claimed"}`
- 删除寄语（`DELETE /api/message-wall/:id`）**不会**退回已领的 Token：`claimed` 仍然是 true，
  只有 `completed` 回落到 false

## 7. 错误出口

`src/http.mjs` 的 `CODES` 是唯一词表：

| 场景 | status | code |
|---|---|---|
| 没凭据 / 凭据过期 | 401 | `sign_in_required` / `session_expired` |
| 模型不存在（宿主应搁置这个模型，不换号） | 404 | `model_not_found` |
| 上游 5xx | 503 | `upstream_unavailable` |
| 超时 / 流被截断 | 504 | `upstream_timeout` |
| 请求体不合法 | 400 | `invalid_request` |

模型通道的请求由 `@ai-sdk/openai-compatible` 直接发往上游，插件不包裹 `fetch` ——
所以上游的错误 status 会原样交给宿主。这是有意的：少一层改写，少一类「404 被写成 401」的事故。

## 8. 隔离浏览器登录

`src/browser-login.mjs`（通用）+ `src/web-login.mjs`（本插件的策略）。

流程：

1. `findBrowser()` 按优先级探测 Chromium 内核浏览器：Chrome → 国产 Chromium（360 / QQ / Sogou / 2345 / 猎豹 / Maxthon / UC / Quark）→ Edge。
   Windows 额外走注册表 `App Paths`（找不到时静默，不把 `reg query` 的报错刷进日志）。
2. `mkdtempSync(tmpdir(), "magpie-login-")` 建一次性 profile，`--user-data-dir` 指过去。
3. 开 `--remote-debugging-port=<随机空闲端口>`，等 CDP 的 `/json/list` 给出页面 WebSocket。
4. 每秒 `Network.getAllCookies` 一次，挑 `ANASID` / `opc_sid`；
   两个都拿到就收工（`readyToFinish` 是「且」不是「或」）。
5. `finally` 里杀进程 + `rmSync(profile, { recursive: true })`。

实测（2026-11-03）：本机 `msedge` 被选中，窗口能开、CDP 能连；无人登录时 20 秒超时
后返回 `{"type":"failed","error":"受控浏览器登录没走完：登录超时：没有拿到 ANASID / opc_sid"}`，
临时目录已清理。

只要求 `ANASID` + `opc_sid` 的依据：实测只带这两个，`/api/model-service` 与 `/api/auth/me`
都返回 200；`ANACCOUNT` 可有可无（它是 365 天的账号标识，不参与鉴权判定）。

## 9. 每日任务闸门（不浪费 Token 的那部分）

`src/tasks.mjs` 的 `gateTask(task)` 是唯一入口，按站点返回的状态位分四档：

| 条件 | 动作 | 依据 |
|---|---|---|
| `claimed === true` | `done` | 今天已经领过，再发也不会有第二份奖励 |
| `completed && claimable` | `claim` | 内容已经在站上，只需 `POST /benefits/claim` |
| `completed && !claimable` | `skip` | 内容在审核或未结算，重发只会多一条无效内容 |
| `limitReached` / `!quotaAvailable` / `!enabled` | `skip` | 名额用尽或活动关闭 |
| 其余 | `do` | 才允许发布内容 |

发布内容后立刻 `POST /benefits/claim`；**领取成功才清理**：`DELETE /api/projects/:id`、
`DELETE /api/community/posts/:id`、`DELETE /api/requirements/:id`。
顺序不能反 —— 先删会让 `completed` 回退成 false，`claimable` 也随之消失，当天就领不到了。
`tests/tasks-order.test.mjs` 用假站点把「claim → delete」的先后钉死（断言 `deleteAt > claimAt`）。
寄语不删：它是签到本身的产物，删掉会让卡片上的当日进度回退。
同一账号用内存锁 `running` 串行化（登录回调与签到钩子可能同时触发），
且以 `claimed` 状态为准 —— 锁失效也不会重复发。

实测（2026-11-03，当天 3 条已领）：

```
{ "results": [
    { "id": "plaza_post", "status": "done" },
    { "id": "project_publish", "status": "done" },
    { "id": "message_wall", "status": "done" },
    { "id": "requirement_publish", "status": "skip", "reason": "需要实名认证（当前：pending）" } ],
  "reward": 0, "message": "已领 3，跳过 1" }
```

## 10. 已知限制

- 站点不提供上下文窗口长度，`limit.context` 多数模型是省略的
- 图像 / 视频生成模型没有接进 magpie 的供图通道（`DrawsID` / `ImagesAPI`），列进来会在 chat 里选中报错
- 没有自动续期：cookie 7 天后过期，需要用户重新登录（隔离窗口或粘贴都行）
- 隔离浏览器登录依赖本机装有 Chromium 内核浏览器；没有的话会明确提示改用「粘贴 Cookie」
