# NOTICE

本项目的**工程结构与若干通用原语**派生自以下以 MIT 许可发布的项目。
实现已按本插件的上游（FiimeOPC）重写：没有复制厂商域名、令牌格式、模型目录或额度表。

## MYCF711/magpie-plugin-scaffold

- 仓库：https://github.com/MYCF711/magpie-plugin-scaffold
- 许可：MIT
- 吸收内容：仓库结构、九钩子装配方式、`scripts/check.mjs` / `score.mjs` /
  `privacy-scan.mjs`、`src/quota.mjs`、`src/usage-cache.mjs`、`src/store.mjs`、
  `src/model-context.mjs`、`src/http.mjs` 的错误词表、
  `src/browser-login.mjs`（受控 Chromium + CDP 取 Cookie 的通用实现）。

## magpie-community/plugins

- 仓库：https://github.com/magpie-community/plugins
- 许可：MIT
- 吸收内容：SSE 折叠与 tool_calls 合并的思路（`src/openai-sse.mjs`），
  本插件保留该模块用于非流式折叠，未直接在上游请求路径使用。

## MYCF711 自有 MIT 插件

- `magpie-magicrew-auth` — https://github.com/MYCF711/magpie-magicrew-auth
  - `src/model-context.mjs`：查 `~/.cache/magpie/models.json` 的递归索引与 TTL 缓存模式
- `magpie-loomy-auth` — https://github.com/MYCF711/magpie-loomy-auth
  - `tests/mount.test.mjs`：入口唯一函数导出 / 九钩子 / config / loader / usage 的挂载测试结构

以上项目的版权归各自作者所有，按 MIT 许可使用。本项目自身同样以 MIT 许可发布，完整许可正文见 `LICENSE`。
