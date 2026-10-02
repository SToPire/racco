# Agent Note: Codex 传输故障限制在 Provider 内

Status: implemented

## Problem

原生进程关闭输入管道但尚未退出，或通知映射拒绝异常数据时，错误可能逃出异步回调并终止整个 daemon，连带中断其他 Provider 的会话。

## Decision

Codex 管道错误、消息分发异常和服务端请求回写失败统一结束该 Provider，拒绝仍在等待的 RPC，并停止其原生进程。错误不能逃出传输回调，也不能在验证响应前丢失待完成请求；故障后的通知不继续作为正常执行事实消费。

同范围检查保留[后台子任务事件](2026-09-22-codex-background-child-events.md)与[工具终态](../feature/2026-09-22-tool-lifecycle-states.md)的状态收束决定，本记录补充触发 Provider 失败的传输边界，不替代历史归属、问答权限或自动重放策略，没有需要归档的记录。

## Alternatives considered

**仅捕获发送时的同步异常：** 管道错误可能稍后通过流事件报告，无法阻止未处理的异常终止宿主。

**忽略异常并继续接收：** 映射或通信状态已不可靠，继续执行可能遗留等待请求并展示错误状态。只结束出错 Provider，保留 daemon 与其他 Provider。

## Consequences

一次 Codex 传输故障会影响共享该原生进程的 Codex 会话，但不会要求整个服务随之退出。未确认的变更不自动重发；临时图片仍遵守[确认原生进程退出后清理](../feature/2026-09-27-ephemeral-chat-images.md)的边界。[真实子进程回归测试](../../../../src/server/drivers/codex/app-server-client.test.ts)覆盖管道断裂、异常通知和响应错误，验证待完成请求能结束且宿主继续运行。
