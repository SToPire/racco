# Agent Note: Claude 工具回调遵守全权限模式

Status: implemented

## Problem

Claude 驱动已经启用全权限模式，但工具回调仍将普通工具和退出规划等控制操作送到用户审批，导致同一次执行受到相互矛盾的权限处理。

## Decision

工具回调只将 AskUserQuestion 转为用户问答，其余工具直接允许，保持全权限执行语义。工具执行仍进入已有时间线，用户回答继续通过回调传回 Provider。

同范围检查未发现需要替代的独立权限记录；本修复落实既有运行契约，不改变[流式输出](2026-09-18-claude-streaming-output.md)的事件映射与历史归属。

## Alternatives considered

**移除工具回调：** 能避免额外审批，但也会失去 AskUserQuestion 的用户交互入口。

**只放行退出规划等已知工具：** 其他工具仍可能出现同类审批，与统一的全权限模式不一致。

## Consequences

普通工具和规划切换不再要求额外批准；AskUserQuestion 仍等待用户回答。这沿用现有全权限边界，回调不再充当普通工具的审批层。
