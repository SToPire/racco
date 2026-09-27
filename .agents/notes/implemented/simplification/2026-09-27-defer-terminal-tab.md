# Agent Note: 暂不加入 Terminal 页签

Status: implemented

## Problem

Terminal 页签可以在 WebUI 中提供原生 CLI 操作，但目前缺少足以证明其必要性的具体使用场景。尤其是 Claude，保留现有 Agent SDK 接入并支持原生 TUI，需要处理执行权、进程生命周期和历史同步；尚无已验证的低成本方案，预期收益不足以支撑这些改动和维护负担。

## Decision

Racco 暂不加入 Terminal 页签，继续提供 Chat 与 Trajectory，并沿用现有结构化 Provider 接入。这是针对当前需求和技术条件的阶段性决定，可以被未来的新场景或接入机会推翻，不构成永久禁止。

范围核对保留[跨视图会话控制](../feature/2026-09-22-continuous-session-controls.md)、[会话切换缓存](../bug-fix/2026-09-22-session-switching.md)和[原生历史归属](2026-09-17-session-state-without-turn-ledger.md)的现有决策；主分支没有需要替代或归档的 Terminal 记录。此前原型仅作历史参考，不作为后续实现基础。

## Alternatives considered

**保留 Agent SDK 并加入原生终端：** 可以保留现有结构化交互，但增加会话执行方式交接与一致性维护，当前没有明确场景证明这些成本值得承担。

**统一使用常驻 CLI，Chat 读取 transcript 并代理终端输入：** 可以让 Chat 与 Terminal 共用执行实例，但需要调整现有发送、问答和控制方式；目前也缺少足够的产品收益支持这项改造。

## Consequences

当前 WebUI 的能力范围保持在结构化对话与执行轨迹，原生 CLI 操作仍通过独立终端完成，避免为尚不明确的需求扩大执行架构。

未来出现 Chat／Trajectory 难以合理满足的具体场景，或 Provider 提供能够明显降低集成成本的新能力时，可以重新提出 Terminal 方案。届时按实际用户收益、可验证的接口能力和维护成本重新判断，并通过小范围原型与可独立审计的改动验证；本记录不预先绑定新的实现路线。
