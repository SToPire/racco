# Agent Note: 工具详情优先呈现结果并保留阅读位置

Status: implemented

## Problem

工具详情默认打开参数和执行元数据，用户查看完成或失败的调用时仍需寻找实际输出；持续更新的输出还需要兼顾追踪进展与回看已有内容。

## Decision

[工具详情](../../../../src/web/components/ToolInspector.tsx)在用户尚未选择选项卡时优先呈现已有输出，手动选择后不因输出到达或状态变化切走。命令先于折叠的执行元数据，Codex 文件变更保留专用差异视图，原始记录继续可查。输出可完整复制；原先可切换的日志跟随状态已由[普通滚动阅读](../simplification/2026-09-22-tool-log-scrolling.md)替代，结果优先和阅读选择仍有效。界面呈现记录中的结果和失败状态，不从任意输出文本推断新的错误原因。

本决策只调整工具详情的阅读体验，不改变[Claude 流式输出](../bug-fix/2026-09-18-claude-streaming-output.md)的事件来源或[即时会话错误](../simplification/2026-09-19-session-errors-are-transient.md)的保存边界。相关活动记录继续有效，没有需要替代的工具详情决策。

[单一输出展示](../simplification/2026-09-22-single-tool-output.md)进一步限定 Output 只显示和复制模型收到的文本；Claude 原生结构化差异不再额外呈现在 Output，Codex 文件变更的 Changes 入口继续有效。

## Alternatives considered

**始终先展示输入或元数据：** 便于协议排查，但增加阅读结果所需的操作；原始记录和折叠元数据已保留这一排查能力。

**每次更新都跳到输出并滚至末尾：** 能突出最新进展，却会打断参数检查和失败日志回看；用户已经表达的阅读选择优先。

## Consequences

已有结果可直接阅读，诊断数据仍按需可用。选项卡选择仅属于当前工具详情的界面状态；实际输出频率仍由 Provider 事件决定，界面不会补造尚未收到的输出。
