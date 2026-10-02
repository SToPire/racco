# Agent Note: Driver 输出稳定的工具展示事实

Status: implemented

## Problem

共享工具事件仍要求浏览器识别两家 Provider 的原生命令动作和结构化结果。普通摘要、差异和命令详情因而随原生格式变化，Driver 与界面重复承担同一解释边界。

## Decision

Driver 在实时与历史映射时输出少量可选 ToolFacts：摘要、命令、工作目录、退出码、最终耗时、统一差异及后台任务身份。只映射已知原生字段，不从结果文本推断事实；缺失信息保持未知。开始事件提供输入事实，完成事件补充结果事实。普通卡片与详情只读取共享事实，原始输入和完整详情继续用于字面展示与 Raw 诊断。

本记录部分调整[工具活动摘要](../feature/2026-09-22-tool-activity-summaries.md)、[Claude 结构化结果](../bug-fix/2026-09-22-claude-structured-tool-results.md)和[统一差异](../bug-fix/2026-09-22-file-change-diff-contract.md)的解释归属，保留其事实真实性、原生保留和差异语义。[工具详情](../feature/2026-09-22-tool-inspector-results.md)共用命令与 Changes 展示；[单一输出](../simplification/2026-09-22-single-tool-output.md)仍限定 Output 为模型收到的文本。没有完整替代的记录。

## Alternatives considered

**继续由浏览器解析原生结果：** 改动较小，但原生字段变化仍穿过多层 UI，无法形成可靠的共享边界。

**统一所有 MCP 输入输出或建立工具插件注册系统：** 工具语义开放且多变，当前普通展示只需要少量稳定事实。未知工具保留名称和字面输入，详细原生数据通过 Raw 查验。

## Consequences

两家工具可以复用普通展示，原生格式变更集中在各自 Driver；共享字段增加仍需要协议与消费者一起修改。事实和 Raw 会重复少量数据，接受这个成本以保留诊断来源。后台任务回执不代表任务已结束，空差异不证明文件未改变，最终耗时不由前端计时补造。
