# Agent Note: 文件变更使用统一差异语义

Status: implemented

## Problem

Codex 新增和删除文件提供文件原文，修改文件才提供 unified diff；Claude Edit/Write 则提供结构化差异片段。把这些输入统一按行首符号统计，会把新增 Markdown 列表显示成删除，也会漏算以递增或递减操作符开头的真实代码变更。

## Decision

共享文件变更的展示契约只承载 unified diff。Codex 原文在驱动边界按新增或删除类型转换，原生完整项仍保留在详情中；Claude 继续从原生结构化片段生成差异。空文件、空行和末尾换行状态保持实际含义，不让原文中的符号改变变更方向。

摘要统计和差异着色共用按 hunk 范围识别行的规则，文件头只在片段外解释，片段内的递增、递减及类似文件头的代码仍是变更内容。本记录补充[工具活动摘要](../feature/2026-09-22-tool-activity-summaries.md)与[Claude 结构化结果](2026-09-22-claude-structured-tool-results.md)的同一事实来源要求；两项原有决定继续有效，没有完整替代记录。

## Alternatives considered

**仅根据文件新增或删除类型在前端重算：** Claude 的新增文件已经是 patch，单靠类型会再次误读格式；在原生边界统一表达更明确。

**只排除三个加号或减号开头的行：** 相同前缀也可能是普通代码，不能证明它是文件头；片段边界决定行的含义。

## Consequences

两家 Provider 的活动摘要与 Codex Changes 详情使用同一差异语义，原生数据可通过 Raw 核对；Claude Output 遵循[单一输出展示](../simplification/2026-09-22-single-tool-output.md)，不再额外展示原生差异。所有当前生产端和测试夹具采用统一展示契约，不保留同时猜测原文与 patch 的兼容分支。
