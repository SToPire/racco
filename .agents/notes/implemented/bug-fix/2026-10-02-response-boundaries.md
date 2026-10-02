# Agent Note: 响应边界校验与详情故障隔离

Status: implemented

## Problem

把可解析 JSON 直接断言为领域类型，会让缺失字段和错误状态进入 reducer；单个工具的原生详情渲染抛错也可能卸载整个会话界面。

## Decision

WebSocket 与 REST 在进入浏览器领域状态前按当前严格 schema 校验一次，结构错误成为可见读取或连接错误，不猜测旧格式。标准化时间线与目录字段受校验，Provider 原生输入和详情保留为 unknown。工具详情使用局部错误边界，失败后保留对话并提供关闭入口，切换详情重新尝试渲染。

本记录补充[不可用会话导航](2026-10-02-unavailable-session-navigation.md)的读取失败语义与[目录归并](2026-10-02-catalog-reconciliation.md)的数据边界；前者继续持有重试/返回行为，后者继续持有事件顺序。同范围没有完整替代记录。

## Alternatives considered

**各组件重复检查字段：** 检查分散且易漏，仍会让非法对象进入共享状态，边界校验使领域消费者依赖明确合同。

**把所有 Provider 原生详情强行统一为 schema：** 不同工具的诊断字段本来不构成 Racco 的共享合同，保留原始值并隔离可选详情渲染更合适。

## Consequences

错误响应不会部分应用，旧格式立即失败。新增共享字段必须更新当前 schema 与类型；原生详情仍可能无法渲染，但故障范围不超过详情面板。
