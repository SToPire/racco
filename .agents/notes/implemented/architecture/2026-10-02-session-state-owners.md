# Agent Note: 会话运行状态按不变量划分所有者

Status: implemented

## Problem

Hub 同时直接维护历史版本、读取引用、活动回合以及问答 Promise 的注册、取消和关闭。修复一个竞态时必须在多处分支同步字段，容易漏掉版本递增、终止广播或监听器释放。浏览器目录也需要跨读取与实时事件维护关系。

## Decision

SessionRuntime 拥有临时历史与版本、读取引用、回合和压缩互斥，以及持久摘要刷新时必须保留的临时字段；调用者通过领域操作改变这些状态。SessionInteractions 拥有每个问答的一次性结算、原生取消监听与会话终止清理，通过明确事件及剩余问题数把广播和执行状态持久化交给 Hub。Hub 继续协调仓库、Provider、权限和传输，不替换为通用工作流框架。

浏览器目录不变量已由[目录归并](../bug-fix/2026-10-02-catalog-reconciliation.md)的 reducer 统一维护；本次保留它的完整范围。[会话切换](../bug-fix/2026-09-22-session-switching.md)继续持有显示缓存和失效读取策略，[无逐轮记录](../simplification/2026-09-17-session-state-without-turn-ledger.md)继续持有持久化取舍。上述记录均只部分补充，没有完整替代项。

## Alternatives considered

**按方法数量把 Hub 拆成多个文件：** 若字段仍可被任意位置修改，边界没有减少维护风险；模块应拥有能独立验证的不变量。

**把仓库、运行态与 Provider 对象统一为一种会话模型：** 它们的生命周期和事实来源不同，统一对象会模糊删除、恢复和实时状态的责任。

## Consequences

版本更新、读取引用释放和问答结算能够直接进行确定性回归，Hub 集成回归仍验证广播、数据库和 Provider 的配合。运行态仍是可丢弃的内存数据，不能成为新的历史或任务账本。
