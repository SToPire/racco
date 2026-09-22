# Agent Note: Chat 的可理解执行过程

Status: proposed

## Problem

Chat 的工具组只显示调用数量，展开后的工具仍缺少动作和对象；运行、失败及文件结果需要逐层进入详情。子任务会抢走阅读焦点，轨迹视图隐藏问答和停止入口，运行时禁止准备草稿，长对话没有跟随与阅读位置策略。Provider 提供的计划、公开推理摘要、结构化工具结果与任务进度也未完整进入展示协议，实时与历史的能力存在差异。

## Proposal

按用户收益将改动分成可分别保留或撤销的决策：首先利用已有输入和结果恢复工具语义、关键状态及可读详情；其次修复子任务阅读、跨视图操作、草稿与滚动连续性；最后补齐 Provider 的展示性事件、结构化结果、任务归属及准确的轨迹定位。每个独立行为变更使用单独提交和完成记录，尚未完成的范围保持提案状态。

动作摘要表达意图，结果摘要只表达原生结果支持的事实；运行、失败和待用户输入不能仅藏在数量汇总中。DeepSeek Harness 的语义工具行、专用结果卡片值得借鉴，但其多层折叠、仅按活动类别总结和后台任务状态脱节同样增加理解成本，因此不照搬整个展示或插件体系。相关比较依据为[工具行实现](https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/packages/client/ui-tool/src/client/tool/components/ToolRow.tsx)与[过程展示规则](https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/packages/client/ui-chat/src/client/conversation-nodes/README.md)。

本提案补充[Claude 文本流式输出](../../implemented/bug-fix/2026-09-18-claude-streaming-output.md)，保留[无逐轮记录](../../implemented/simplification/2026-09-17-session-state-without-turn-ledger.md)的原生历史归属和[仅用户问答](../../implemented/simplification/2026-09-19-question-only-interactions.md)的交互边界。范围内没有被完全替代的既有记录。运行时草稿改善不改变[压缩忙碌反馈](../../implemented/feature/2026-09-17-compaction-busy-feedback.md)期间禁止编辑的决定。

## Alternatives considered

**将所有原始调用默认展开：** 能增加可见信息，但长输出会淹没对话，无法解决语义丢失与操作连续性。

**为每条工具调用生成模型摘要：** 增加等待、成本和解释偏差；优先使用已有描述与可核实结果，模型生成的阶段说明只在原生已提供时消费。

**一次合并所有界面和协议改动：** 不利于维护者分别评估收益与撤销行为；分开决策与提交，同时保持每个提交的当前契约完整。

## Acceptance criteria

默认 Chat 能说明主要动作、对象、执行状态和有据可查的结果；失败和待回答问题直接可达。启动子任务、流式更新及查看详情不意外改变用户阅读位置。实时与原生历史使用同一语义投影，不能恢复的瞬时信息明确限定为实时。各项改动有独立决策记录和针对行为的验证。

## Risks

不同 Provider 能提供的实时进度与历史信息不同，不能把未知值、输入描述或调用次数冒充成功结果或完成比例。更多可见内容会增加小屏占用，需要保留摘要与按需详情的层次。轨迹归属及发送期间的控制必须遵守原生能力，不能用前端猜测补齐，也不因展示需求恢复持久化逐轮账本。
