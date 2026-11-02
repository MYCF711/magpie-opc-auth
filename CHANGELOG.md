# Changelog

本文件记录这个插件的每个发布版本。格式照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号照 [SemVer](https://semver.org/lang/zh-CN/)。

## 0.1.0 — 2026-11-03

第一个版本。把这个站点现有的两块能力接进 magpie：

- **隔离浏览器登录（推荐）**：插件开一个一次性 profile 的 Chromium 窗口，用户在里面正常登录
  `opc.fiime.cn`，插件从 CDP 读走 `ANASID` + `opc_sid` 后关窗并删除临时目录；
  不读写用户日常浏览器的任何数据。真机验证：能开窗、能连 CDP、超时会清理并报明确原因。
- **另外两条登录路**：粘贴浏览器 Cookie（`ANASID=` / `opc_sid=`）、粘贴 API Key（`opc_sk_…`），
  运行时按凭据形状识别，不靠登录方式猜。
- **额度卡片**：Token 余额（钱包型窗口）、今日用量 / 每日上限（北京时间 0 点重置）、
  今日任务进度（4 个每日任务领了几个）。
- **模型通道**：OpenAI Chat 形状的 `/api/model-service/v1`，17 个聊天模型；
  Cookie 登录时插件会用 cookie 自动创建一把 API Key 并落盘，因此一次登录额度与通道都齐。
- **每日签到**：`message_wall`（寄语墙）任务，发一条 ≥20 字寄语并领取 1000 万 Token；
  已有可领取的奖励时直接领取，不重复发帖。
- **三态降级**：`/v1/models` 失败退回静态表；单条模型缺字段不列；登录失效抛 `signIn: "expired"`。
- 上下文窗口长度不写死：站点不提供，查不到就不写，绝不猜（CHECKLIST A-8）。
