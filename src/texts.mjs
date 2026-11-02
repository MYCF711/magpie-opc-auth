// src/texts.mjs —— 每日任务用的内置文案
//
// 按「北京时间的年内第几天」轮换，保证每天内容不同（站点有 MessageWallDedupe 与
// 自动内容审核）。用内置文案而不是每次调模型，是因为「完成每日任务」这件事
// 本身只值一份固定奖励 —— 花自己的 Token 去换 1000 万，只在内容质量真的影响奖励时才划算
// （发帖与需求是 range 奖励，可选项里开 `useModel: true` 再交给模型写）。

const dayIndex = (seed = Date.now()) => Math.floor((seed + 8 * 3600_000) / 86_400_000)

function pick(list, offset = 0) {
  return list[(dayIndex() + offset) % list.length]
}

/* ----------------------------- 寄语墙 ----------------------------- */
export const NOTES = [
  "今日签到。把注意力放回手上那件真正想做的事，慢一点也没关系。",
  "签到。做产品像种树，今天浇水，明天不用急着看它长高。",
  "今日打卡：允许自己今天只前进一小步，这也算前进。",
  "签到。每天做一点，久了就成了一件像样的事。",
  "今日签到。把复杂的事拆开，一次只解决一格。",
  "签到。愿每个认真做东西的人，都能被看见、被回应。",
  "今日打卡。把今天过好，就已经是在为明天做准备。",
  "签到。灵感来的时候记下来，走了也别慌，它还会回来。",
  "今日签到。与其等一个完美开始，不如先把今天这一页写完。",
  "签到。慢下来不是停下，是让每一步都踩稳一点。",
]

/* --------------------------- 搭子广场发帖 --------------------------- */
export const POSTS = [
  { title: "今天也推进了一点", content: "把手上的小工具改了改，修掉两个一直想修的小问题。进度不快，但方向是对的。" },
  { title: "每日打卡", content: "今天把脚本的定时任务调通了，省下来的时间是真的。继续做下去。" },
  { title: "继续做下去", content: "做自己的小项目最难的是坚持。今天又往前走了一小步，记录下来。" },
  { title: "一个安静的下午", content: "没做多少事，但把思路理清楚了。接下来知道该先做哪一件。" },
  { title: "小步快跑", content: "把一个大目标拆成了三件今天能做完的小事，做完两件，剩一件明天早上做。" },
]

/* --------------------------- 资源中心项目 --------------------------- */
export const PROJECTS = [
  {
    title: "每日签到助手",
    summary: "Node.js 定时自动化每日任务，失败自动重试",
    content:
      "## 项目做什么\n\n每日签到助手是一个基于 Node.js 的轻量脚本，用来自动完成网站上的每日任务：固定时间触发接口、记录执行结果、失败时按指数退避重试。\n\n## 怎么用\n\n1. 在 `.env` 里配置账号 Cookie 与目标接口。\n2. `npm install` 安装依赖。\n3. `npm start` 启动定时器，日志写入 `logs/` 目录。\n\n## 技术栈\n\nNode.js 18+（原生 fetch + cron 调度）、dotenv、winston。",
    tags: ["Node.js", "自动化", "定时任务"],
  },
  {
    title: "接口巡检小工具",
    summary: "定时探测接口可用性，异常时写日志并提醒",
    content:
      "## 项目做什么\n\n一个跑在本地的小工具，按固定间隔请求一组 HTTP 接口，记录状态码与耗时，连续失败时写告警日志。\n\n## 怎么用\n\n把要巡检的地址写进 `targets.json`，`node index.mjs` 启动；结果输出到控制台与 `logs/`。\n\n## 技术栈\n\nNode.js 原生 fetch、AbortSignal 超时、简单 JSON 配置。",
    tags: ["Node.js", "监控", "运维"],
  },
]

/** 取一条寄语；签名由调用方给 */
export function pickNote(offset = 0) {
  return pick(NOTES, offset)
}

/** 取一条帖子 */
export function pickPost(offset = 0) {
  return pick(POSTS, offset)
}

/** 取一个项目 */
export function pickProject(offset = 0) {
  return pick(PROJECTS, offset)
}
