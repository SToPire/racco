# Agent Note: 压缩期间禁用输入并显示持续反馈

Status: implemented

## Problem

Codex 接受压缩请求和完成压缩之间存在等待时间。只显示请求受理提示或很快结束的 loading 无法表达实际进度，也允许用户在压缩期间提交新消息或再次压缩。

## Decision

从提交压缩到 Provider 报告完成或失败，输入区置灰，禁用文本、发送、模型选择和压缩按钮，并持续显示转圈与“正在压缩…”。不显示受理文本。Racco 仅维护当前压缩的运行时标记，同步到快照和其他客户端，并阻止新的普通生成或压缩请求；正常生成期间也不能启动手动压缩。RPC 确认与中间用量更新不代表完成，Provider 退出或不可重试错误必须解除忙碌状态并显示错误。

此决策部分替代[上下文控件](2026-09-17-codex-context-controls.md)的即时受理提示和[无逐轮记录的会话管理](../simplification/2026-09-17-session-state-without-turn-ledger.md)中请求返回即恢复交互的选择。保留两者的原生压缩、Provider 历史归属和不保存逐轮记录的约束；状态仅存在于当前运行的 daemon，不增加数据库字段或跨重启重放。

## Alternatives considered

**只显示“已接受”或只等待 RPC 返回：** 无法让用户感知后台仍在压缩，也没有阻止期间提交任务。

**只禁用当前浏览器：** 刷新、重连或另一个客户端会绕过限制；需要由 daemon 同步一个当前操作标记。

**恢复持久化执行表：** 当前交互只需临时忙碌状态，不需要逐轮历史、审计或恢复记录。

## Consequences

输入草稿保留，完成、失败和 Provider 退出后自动恢复交互；不同线程的结束通知不得提前解除锁定。页面刷新和客户端重连可恢复忙碌展示，daemon 重启则丢弃该临时标记，不补发压缩请求。上下文用量继续来自 Provider 报告，数据库 schema 保持不变。行为由[会话协调器](../../../../src/server/session-hub.ts)和[Codex Driver](../../../../src/server/drivers/codex/codex-driver.ts)持有。
