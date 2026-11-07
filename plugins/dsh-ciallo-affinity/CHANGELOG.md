# Changelog

## 1.1.0 — 2026-11-07

- 子智能体（fork / spawn）沿 `parentSession` 归到根会话，使用根会话的 `session_id`；新增 `subagents: root | own` 配置。
- `providers` 支持多个路由；`deviceId` 留空时默认 `dsh-<主机名>`。
- 状态接口 `/__ciallo-affinity` 新增最近会话列表（会话 → 根会话、层级、请求数），用于核对新对话的 id 是否不同、子智能体是否归到根会话。
- 内部请求头（会话 id、请求用途）转发前一并删除。

## 1.0.0 — 2026-11-07

- 首版：request-headers 钩子 + 本机中转，给 `/v1/messages` 补 `metadata.user_id`。网关日志确认粘性来源从 `cacheable_content` 变为 `metadata_user_id`，切换后连续请求固定在同一账号。
