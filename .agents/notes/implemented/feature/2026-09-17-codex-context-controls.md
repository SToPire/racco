# Agent Note: Codex 上下文用量与独立压缩操作

Status: implemented

## Problem

用户需要判断 Codex 主会话的上下文占用并主动腾出空间。当前消息输入只启动普通生成，不能表达独立压缩；累计 token 消耗也不能反映当前上下文占用。

## Decision

Codex 会话提供专用压缩按钮和上下文用量／上限指示器，不引入通用 slash-command 分发。压缩调用 Provider 原生能力，不制造用户消息。用量采用 Provider 最近一次报告的主会话上下文 token 数及上限，包含缓存输入；未知值保持未知，不按模型名猜测，也不混入累计消耗或子 Agent 用量。压缩调用和观测值的运行时归属由[会话状态简化决策](../simplification/2026-09-17-session-state-without-turn-ledger.md)持有，替代此前的持久化执行和读数恢复要求。

本记录补充上下文管理的界面能力，保留 Racco 会话身份和 Provider 原生历史归属。[按轮模型选择](2026-09-17-composer-model-selector.md)继续约束消息发送，压缩不提交模型草稿或改变模型偏好。

## Alternatives considered

**实现完整 slash-command 菜单：** 超出当前只需压缩的交互范围，也增加不必要的命令解析和维护成本。

**将 `/compact` 当作普通消息：** 不能保证触发原生压缩，并混淆用户对话与会话管理操作。

**只在浏览器保存读数：** 刷新、多客户端和重连会失去一致性；Racco 运行时缓存最近观测值，持久化成本与取舍由后续简化决策处理。

## Consequences

压缩可独立于模型目录和输入草稿执行，当前能力仅面向 Codex 主会话。指示器是最近观测值，未取得 Provider 报告时显示未知，不能当作持续精确测量。压缩期间的交互由[压缩忙碌反馈](2026-09-17-compaction-busy-feedback.md)持有，取代请求返回即恢复按钮及受理文本提示的行为；原生完成或失败通知决定输入区恢复时机。实现约束由[Driver](../../../../src/server/drivers/codex/codex-driver.ts)和[会话协调器](../../../../src/server/session-hub.ts)持有。
