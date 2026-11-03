// src/options.mjs —— 插件选项的归一化
//
// 所有选项都有默认值：多数人不填任何一项也能用。
// 选项来自 magpie 的插件配置（plugins.json 里这个包的那一项）。

export const DEFAULTS = Object.freeze({
  /** 可选：不通过登录界面，直接把浏览器 Cookie 写在这里（适合自动化部署） */
  cookie: "",
  /** 可选：直接用一把已有的 API Key（只够跑模型，额度需要 cookie） */
  apiKey: "",
  /** 用 cookie 登录时，自动创建/复用一把 API Key 供模型通道使用 */
  autoKey: true,
  /** 自动创建的 key 的名字（在站点「模型服务 → 密钥」里能看到） */
  keyName: "magpie-opc-auth",
  /** 签到时用哪条任务作为「每日签到」的动作：message_wall（寄语墙） */
  checkinTask: "message_wall",
  /** 签到文案；留空则用内置文案池按日期轮换 */
  checkinText: "",
  /**
   * 邀请码（可选）：覆盖内置的默认邀请码（`src/context.mjs` 的 `DEFAULT_INVITE`）。
   * 只影响「邀请码注册」那条登录方式第一次打开时带的码；用户自己填过就以用户的为准。
   */
  inviteCode: "",
})

export function normaliseOptions(raw) {
  const src = raw && typeof raw === "object" ? raw : {}
  const out = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    const value = src[key]
    if (value === undefined || value === null) continue
    if (typeof DEFAULTS[key] === "boolean") out[key] = Boolean(value)
    else out[key] = String(value)
  }
  return out
}

/** 插件自己要不要替用户创建 API Key */
export function wantsAutoKey(options) {
  return options?.autoKey !== false
}
