# Agent Note: Chat 的可理解执行过程

Status: implemented

## Problem

Chat 的工具组只显示调用数量，展开后的工具仍缺少动作和对象；运行、失败及文件结果需要逐层进入详情。子任务会抢走阅读焦点，轨迹视图隐藏问答和停止入口，运行时禁止准备草稿，长对话没有跟随与阅读位置策略。Provider 提供的计划、公开推理摘要、结构化工具结果与任务进度也未完整进入展示协议，实时与历史的能力存在差异。

对照 DeepSeek Harness，其工具行已有描述、错误摘录与差异统计，但多层过程折叠、以调用类别代替结果、[运行中 Shell 卡缺少输出](https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/packages/client/ui-tool/src/client/tool/models/terminal-card-model.ts#L284)及后台子任务状态脱节，仍增加理解成本。比较依据为[工具行实现](https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/packages/client/ui-tool/src/client/tool/components/ToolRow.tsx)与[过程展示规则](https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/packages/client/ui-chat/src/client/conversation-nodes/README.md)；Racco 借鉴语义表达，不照搬整个展示或插件体系。

## Decision

最高优先级是利用已有数据恢复默认视图的可理解性：[工具活动摘要](2026-09-22-tool-activity-summaries.md)与[结果优先的详情](2026-09-22-tool-inspector-results.md)区分动作意图和执行结果，运行、失败及缺失结果直接可见。较早的成功活动可以压缩，完整参数和输出仍按需可查。

其次保障连续工作：[子任务卡](2026-09-22-subagent-task-summaries.md)保持阅读对象，[滚动策略](2026-09-22-conversation-reading-position.md)尊重用户回看，[跨视图控制](2026-09-22-continuous-session-controls.md)保留问答、停止和草稿。可读 Chat 与[轨迹定位](2026-09-22-trajectory-location.md)、[Worktree 文件引用](2026-09-22-project-file-references.md)相互连接；子任务本地步骤不冒充主线轮次，文件引用按所属 Agent 的目录解析并受会话 Worktree 边界约束。

进一步补齐原生事实：[Codex 展示性事件](2026-09-22-codex-visible-activity.md)、[工具生命周期](2026-09-22-tool-lifecycle-states.md)、[Claude 结构化结果](../bug-fix/2026-09-22-claude-structured-tool-results.md)及[任务归属](2026-09-22-claude-task-ownership.md)共同保留可获得的语义。[Codex 后台子事件](../bug-fix/2026-09-22-codex-background-child-events.md)不依赖父轮次仍在运行。每项用户行为保持独立决策，共享协议的生产端、消费端与验证作为一个完整契约共同更新。

本记录汇总上述选择的优先级与共同边界，没有完全替代的既有记录。[无逐轮记录](../simplification/2026-09-17-session-state-without-turn-ledger.md)继续持有原生历史归属，[仅用户问答](../simplification/2026-09-19-question-only-interactions.md)和[压缩忙碌反馈](2026-09-17-compaction-busy-feedback.md)继续约束交互；不为展示新增审批、模型摘要调用、持久化执行账本或未受支持的发送队列。

## Alternatives considered

**将所有原始调用默认展开：** 能增加可见信息，但长输出会淹没对话，无法解决语义丢失与操作连续性。

**为每条工具调用生成模型摘要：** 增加等待、成本和解释偏差；已有描述与结构化结果足以改善首层展示，原生未报告的结论保持未知。

**把所有界面与 Provider 改进绑定为一个决策：** 难以分别评估收益和回退行为；按用户行为分开维护，同时保证每次协议修改的当前契约完整。

## Consequences

默认 Chat 可以说明动作、对象和可核实结果，详情继续承担完整证据阅读。桌面与窄屏都保留关键操作；窄屏详情的覆盖范围由[移动端控制修复](../bug-fix/2026-09-22-mobile-trajectory-controls.md)限定。更多可见内容和子历史读取会增加界面空间与读取量，通过摘要、局部滚动和按需详情控制成本。

实时与历史只共享原生可恢复的信息。执行清单、心跳和缺少原生记录的任务终态不能在刷新后补造；未知目录、缺失结果和缺少身份均明确表达。轨迹提供结构化活动与定位，不宣称跨 Agent 精确时序审计；文件预览反映当前文件系统，不能冒充历史文件快照。
