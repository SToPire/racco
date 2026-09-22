# Agent Note: 工具结果只展示模型收到的输出

Status: implemented

## Problem

工具详情同时展示原生 stdout、stderr 和模型收到的消息，重复内容占据空间，也要求用户理解数据来源的区别才能阅读一次调用。

## Decision

Output 只呈现并复制模型收到的工具结果文本，不再额外展示 Claude 原生输出分栏、结构化差异或附件元数据。缺少模型文本时保持空输出，不以原生结果补造。这部分替代[Claude 结构化结果](../bug-fix/2026-09-22-claude-structured-tool-results.md)的详情展示决定；结构化数据继续用于工具状态、卡片统计和 Raw 检查，原生事实保留的决定仍有效。

本决策保持[结果优先](../feature/2026-09-22-tool-inspector-results.md)和[普通滚动阅读](2026-09-22-tool-log-scrolling.md)。Codex 文件变更独立的 Changes 入口仍使用原生差异，不属于双份输出展示。

## Alternatives considered

**仅去重相同的文本，或把模型文本折叠：** 数据仍可能部分重叠，继续保留两种输出语义；用户明确选择只阅读模型收到的那份结果，因此不再维护分栏和复制拼接规则。

## Consequences

阅读和复制来自同一文本，不会把模型未收到的原生字段当作结果。代价是 Claude 原生差异及非文本附件没有专用 Output 视图；Raw 仍能检查记录，但不是附件预览。只有出现明确的原生诊断或附件阅读需求时，才重新评估专用展示。
