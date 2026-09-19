# Agent Note: 彻底删除原生会话文件

Status: implemented

## Problem

用户在 Racco 内发现并导入原生会话后，仍需切换到 Codex／Claude CLI 才能清理不需要的会话文件。Racco 已有的“删除对话”只移除自身登记，磁盘文件继续累积，用户无法在网页内完成会话的完整生命周期管理。

## Decision

会话面板每个会话行提供“彻底删除”按钮，通过 Provider 原生接口删除磁盘文件：Codex 走 app-server 的 `thread/delete` RPC（连带 state DB 记录与 rollout 文件），Claude 走 Agent SDK 的 `deleteSession(sessionId, { dir })`（以项目目录为搜索起点，按精确原生 ID 定位，SDK 可搜索关联 worktree）。删除已导入会话时同步移除 Racco 登记并广播 `session.removed`，与“删除对话”入口的清理路径一致。

`deleteSession` 成为 `AgentDriver` 的必需方法：两家 Provider 都原生支持，不留可选分支。删除前执行与读取一致的归属校验——项目目录可用、会话未被其他项目管理、Codex 端先 `thread/read` 比对 thread 的 cwd，防止陈旧原生 ID 误删其他项目的文件；正在执行任务（activeTurn 或压缩中）的会话拒绝删除。

同一 Provider 的同一原生会话，其导入与删除串行执行；删除从状态检查到 Provider 文件删除和 Racco 登记清理期间占用该会话，启动任务和压缩不得穿插其中。模型发现等异步步骤完成后必须重新检查占用状态，失败则释放占用，不阻塞重试或其他会话。删除成功后会话面板重新取得第一页与游标，保留筛选条件，避免沿用删除前的偏移量而遗漏会话。

本决策扩展[按项目浏览并导入原生会话](2026-09-18-project-session-import.md)的能力边界：该记录“导入只读取历史”的约束继续有效，删除是用户显式确认的独立写操作，浏览与导入仍不取得执行所有权。

## Alternatives considered

**仅删 Racco 登录记录：** 已有入口覆盖；磁盘文件继续累积，无法真正释放空间或清理敏感历史。

**用 Codex `thread/archive` 归档而非删除：** 归档保留数据可恢复，但用户需求是彻底清理，且 Claude SDK 无对应归档接口，两家语义无法对齐。

**Racco 直接删除 Provider 磁盘文件：** 需要了解并跟随两家的存储布局（rollout JSONL、transcript 目录、state DB），Provider 升级即失效；走原生接口由 Provider 自己维护一致性。

**仅在删除前检查忙碌状态、删除后保留分页游标：** 异步删除期间仍可启动任务，文件删除后再检查已无法保护它；删除也会移动偏移量分页的边界。会话级互斥与重新加载分别保证操作顺序和列表完整性，代价是同会话操作需要等待或重试，已加载的后续页面需要重新加载。

## Consequences

删除不可恢复，前端二次确认并明示后果。Racco 首次获得对 Provider 会话文件的删除写权，但仅限用户显式操作这一条路径，不引入后台清理。Provider 原生删除失败（文件缺失、CLI 不可用）原样上抛为面板错误，不做静默降级。
