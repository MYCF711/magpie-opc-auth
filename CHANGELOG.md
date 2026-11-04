# Changelog

本文件记录这个插件的每个发布版本。格式照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号照 [SemVer](https://semver.org/lang/zh-CN/)。

## 0.1.6 — 2026-11-04

**上游把网页当回复时不再冒充「API 回复」；`deepseek-v4-1-flash-1017` 已下线，从模型表移除**

事故形态：经 magpie 网关调用 `opc/deepseek-v4-1-flash-1017`，报
`404 Not Found: a web page, not an API reply: "OPC一人公司是什么意思？…"`。

实测（2026-11-04，真实账号）定位到的根因**在站点侧，不在鉴权链路**：

- 站点模型目录从 22 条变成 **21 条**，`deepseek-v4-1-flash-1017` 不在其中；
  `POST /api/model-service/v1/chat/completions` 只要 `model` 不在目录里，
  网关就回 **404 + 站点 SPA 的 HTML 落地页**（`content-type: text/html`，
  `<title>OPC一人公司是什么意思？注册、运营与创业指南-FiimeOPC社区</title>`）
- 同一把 key、同一个地址，`deepseek-v4-flash` / `deepseek-v4-pro` / `opc-txt-v1` 等
  在线模型全部 **200**；假 key 回 401 JSON，无 key 回 401 JSON —— 鉴权与地址都没问题
- 网页 cookie 与 API Key 都还有效（`/api/auth/me` 200、`/api/model-service` 200、
  两把 key `status: active`、余额 7551 万 Token）

改动：

- **聊天通道加 fetch 包装**（`src/chat.mjs` 的 `createChatFetch`）：上游用网页代替
  JSON/SSE 时，当场翻译成一条带 `status` + `code` + 人话的错误 ——
  `401 → sign_in_required`（要人重新登录）、`404 → model_not_found`（只搁置这个模型）、
  其他 `→ 502 upstream_error`。JSON / SSE 一律原样透传（不在 fetch 里读流）。
  文案里带上「上游返回的网页标题」+「去哪个页面挑模型」，不再是营销页标题。
- **静态模型表删掉 `deepseek-v4-1-flash-1017`**（`src/context.mjs` 的 `MODEL_SPECS`），
  并注明「已下线，别按老清单加回来」；README 的模型表同步（22 条/17 text → 21 条/16 text）。
- **记住「哪个模型已下线」**（`src/store.mjs` 的 `readRetired` / `markRetired`）：
  只有「上游 404 + 网页」且「目录快照里查不到这个 id」才落标记，目录快照每次
  成功拉取时由 `provider.models` 写入（`plugin-store-snapshot-opc.json`）——
  抖动不会把好模型钉死。
- **`buildModels` / `keepUnknownModels` 支持 `retired`**：已下线的 id 不再从
  `providers.json` 里被「用户自己加的模型」那条路复列出来（那是 magpie 的文件，插件删不掉）。
- 新增测试 `tests/chat-fetch.test.mjs`（12 条：三种网页形状、透传、UA、body 解析）、
  `tests/models-retired.test.mjs`（7 条：静态表无下线模型、retired 过滤、三态降级）。
  测试 92 → 111，全绿。

⚠ 用户侧动作：`providers.json` 里选中的 `deepseek-v4-1-flash-1017` 需要在 magpie 的
供应商编辑器里换成在线模型（`deepseek-v4-flash` / `deepseek-v4-pro` / `opc-txt-v1` …）。
插件不改 magpie 的配置，只负责把它从目录与本插件的模型表里剔除。

## 0.1.5 — 2026-11-04

**出站 UA 全部换成官方客户端 UA（同步脚手架 0.3.10 的坑表第 38 条）**

- 上游网关按 `<product>/<version>` 形态识别「第三方客户端」，命中即回
  `403 {"error_code":"TM.00000001","error_msg":"网络繁忙，请稍后重试"}`；而 magpie 给插件宿主
  的 UA 固定是 `magpie/<version>`，插件不显式覆盖就原样透传，同样命中
- 本仓库所有打上游的出站点改为显式带**官方客户端** UA；不再出现 `<包名>/<版本号>`、
  `node`、`Bun/…` 或截断的 Mozilla
- 新增 `scripts/check-ua.mjs`（`npm run check:ua`，0 = 合规）、`AGENTS.md` 坑表第 32 条、
  `CHECKLIST.md` 的 UA 勾选项

## 0.1.4 — 2026-11-03

登录方式从 4 条精简到 3 条，并补上「读取默认浏览器凭证」。

- **删掉「粘贴浏览器 Cookie」**：唯一一条要用户开 F12 的路，被新的默认浏览器凭证覆盖。
- **删掉「邀请码注册（隔离窗口）」这条独立入口**：邀请码改由「浏览器登录」在打开前算好 ——
  有码就打开带码的注册页（注册页上有「已有账号？去登录」），省掉一个按钮。
- **新增「读取默认浏览器凭证」**：直接读默认浏览器 Cookies 的副本（只读、不开窗、不碰正在用的浏览器）。
  现代 Chromium（Chrome 127+ / Edge）的 Cookies 是 app-bound 加密（v20 前缀），外部解不开 ——
  这种情况明确提示「改用隔离窗口」，而不是假装"没登录"或静默失败。
  读不到时会区分两种原因：**没在这个浏览器登录过**（建议先登录一次）和 **登录过但加密解不开**。
- 三条登录方式：**浏览器登录（隔离窗口）/ 读取默认浏览器凭证 / 粘贴 API Key**。
- 新增 `src/default-browser.mjs`：默认浏览器识别（Windows 注册表 UserChoice）、多 profile 扫描、
  Cookies 副本 + SQLite 读取、DPAPI + AES-GCM 解密、v20 明确报错。
  平台路径分开写（macOS 的 Chrome 目录没有 `User Data` 这一层、Linux 是 `google-chrome`）。

## 0.1.3 — 2026-11-03

邀请码从「登录页填一个码」改成 **magpie 的插件选项开关** —— 0.1.2 那套四档文本框拆掉了。

- **`auth.options` 新增 `invite-first`**（默认关）：供应商编辑器 →「插件选项」→
  「邀请码挂到首选账号」。
  - 关（默认）= **自动**：跟随上一个注册成功的新号；一个都没有时用内置默认码（作者的码）。
  - 开 = **首选**：挂到 magpie 账号页「首选」那个账号自己的邀请码；它还没记下码时回落自动。
  - 它是 magpie 的 `auth.options`（`settings.PluginOptions[provider][key]`），插件用
    `input.magpie.option(provider, key)` 读，**拨一下立刻生效、不重启 host**。
- **登录方式不再问码**：「邀请码注册（隔离窗口）→ 自动登录」直接按开关算码并打开注册页；
  instructions 里写「本次邀请上级：…」，与真正拼进 URL 的码同源。
- **只有注册成功那一刻才更新「自动」落点**（`opc-invite-registered.json`）——
  普通登录 / 签到只更新账号自己的码（`opc-invite-codes.json`），
  否则重登一个旧号会把下次注册挂回旧号（`magpie-magicrew-auth` 踩过的坑）。
- **三份缓存**：`opc-invite-codes.json`（每账号自己的码，首选模式用）、
  `opc-invite-registered.json`（最后注册的新号，自动模式用）、
  `opc-invite.json`（0.1.2 手填过的码，只当兜底）。
- 想指定任意码：`inviteCode` 选项（plugins.json 的 JSON 配置）或内置的 `DEFAULT_INVITE`。
  magpie 的插件选项只存布尔，做不了「填一个码」的控件 —— 这正是拆文本框的原因。
- `tests/invite.test.mjs` 重写为开关语义（自动 / 首选 / 回落 / 首选账号判定 / 文案同源），
  `tests/mount.test.mjs` 补了 `auth.options` 声明与开关两态的锁。共 92 条断言。

## 0.1.2 — 2026-11-03

邀请码从「用户自己填」变成「有默认值 + 四档语义」。

- **默认邀请码**：新用户第一次用「邀请码注册（隔离窗口）」时，注册页自动带上内置的默认码
  （`src/context.mjs` 的 `DEFAULT_INVITE`；插件选项 `inviteCode` 可覆盖）。
  「第一个号先用自己的码」不再需要用户手填，也不用先存一次策略文件。
- **四档语义**：默认（第一次、不填）→ **自动**（留空 / 输入 `1`：沿用上次的码）→
  **首选**（填自己的码：用它并存下来）→ **不带码**（输入 `-` / `none`：打开普通注册页，
  已有账号可直接登录）。输入统一去空格并转大写（本站的码是 8 位大写字母数字）。
- 「不带码」是一个会被记住的状态 —— 不会在下一次留空时悄悄恢复成默认码。
- `pickInvite()` 把这套归一化收进 `src/invite.mjs`，`tests/invite.test.mjs` 与
  `tests/mount.test.mjs` 各锁一遍（共 89 条断言）。

## 0.1.1 — 2026-11-03

补上邀请机制。本站的邀请码**只影响注册**（`/register?invite=<code>`），
老账号在登录 URL 上带码没有任何效果（实测），所以这里走的是「先问码 → 带码注册 → 自动登录」。

- **登录方式新增「邀请码注册（隔离窗口）→ 自动登录」**：先问「邀请人的码」，
  用 `https://opc.fiime.cn/register?invite=<code>` 打开一次性 Chromium 窗口，
  用户注册完由插件从 CDP 收下 Cookie；留空则打开普通注册页（已有账号可在这里直接登录）。
  多步问答用 `ask()` 串起来 —— 静态 `prompts` 数组串不起「填码 → 主登录」（AGENTS 坑 26）。
- **卡片新增「我的邀请码」一格**：`GET /api/invite` 读到的码 + 已邀请人数 / 付费转化 / Token 奖励；
  只有码、没有邀请记录时只显示码，不编造统计；查不到（没有 Cookie / 接口抖动）就整格不出现，
  不会因为一行只读信息影响主要额度。
- **邀请码策略**：`~/.cache/magpie/opc-invite.json`（`0` / 留空 / `1` 沿用当前，其它当新码）；
  换码时与该码配对的额外参数一起换，避免「填了码但邀请不生效」。
  **不滚动**成自己账号的 `referralCode` —— 下次点这条登录方式时它要还是「邀请人的码」。
- `src/invite.mjs` 从 `magpie-chatbox-ai` / `magpie-cnb-auth` 的通用模块拿过来，按本站语义改了注释与提示文案。

## 0.1.0 — 2026-11-03

第一个版本。把这个站点现有的两块能力接进 magpie：

- **隔离浏览器登录（推荐）**：插件开一个一次性 profile 的 Chromium 窗口，用户在里面正常登录
  `opc.fiime.cn`，插件从 CDP 读走 `ANASID` + `opc_sid` 后关窗并删除临时目录；
  不读写用户日常浏览器的任何数据。真机验证：能开窗、能连 CDP、超时会清理并报明确原因。
- **另外两条登录路**：粘贴浏览器 Cookie（`ANASID=` / `opc_sid=`）、粘贴 API Key（`opc_sk_…`），
  运行时按凭据形状识别，不靠登录方式猜。
- **额度卡片**：只报 `wallet.balance`（账号总余额），不写每日上限；
  真的用尽当日额度时才加一行「已用尽 · N 小时后恢复」、
  今日任务进度（4 个每日任务领了几个）。
- **模型通道**：OpenAI Chat 形状的 `/api/model-service/v1`，17 个聊天模型；
  Cookie 登录时插件会用 cookie 自动创建一把 API Key 并落盘，因此一次登录额度与通道都齐。
- **每日任务执行器**：登录成功后自动跑一轮 4 个每日任务（寄语墙 / 发帖 / 项目 / 需求），
  但**只在状态允许时动手** —— 已领的跳过、已完成可领的只领、审核中的不重发、
  名额用尽的跳过、实名未通过的不发请求。默认用内置文案（0 Token），可选 `useModel` 换成模型生成。
- **内置项目封面**：项目任务强制要求预览图，随包带一张 3.6 KB 的 PNG。
- **模板内容自动清理**：帖子 / 项目 / 需求在领取奖励成功之后 `DELETE` 掉（顺序有测试锁）；
  寄语保留（它是签到本身）；`keepPublished: true` 可关闭清理。
- **三态降级**：`/v1/models` 失败退回静态表；单条模型缺字段不列；登录失效抛 `signIn: "expired"`。
- 上下文窗口长度不写死：站点不提供，查不到就不写，绝不猜（CHECKLIST A-8）。
