# Agent Note: 导航控件的语义与键盘模式一致

Status: implemented

## Problem

部分按钮声明 listbox、menu 或 tab 角色却缺少相应键盘操作，轨迹行的 listitem 角色又覆盖了按钮语义，使辅助技术与真实行为不一致。

## Decision

Agent 选择保留单选 listbox，并提供打开聚焦、箭头与首尾移动、选中和关闭后恢复；工具详情标签采用单一 Tab 停靠点和左右键切换。用户请求导航使用普通按钮，无需伪装应用菜单；轨迹列表把 listitem 放在外层容器，内部动作保持按钮。此决策补充[轨迹定位](../feature/2026-09-22-trajectory-location.md)和[工具详情](../feature/2026-09-22-tool-inspector-results.md)，不改变功能归属，没有完整替代的记录。

## Alternatives considered

**所有控件统一自定义菜单：** 增加无必要的复合控件状态与键盘约定。仅补 ARIA 标签则不能修复箭头操作、焦点位置与当前项的真实行为。

## Consequences

键盘用户可以辨认当前位置并完成选择，Tab 停靠数量与控件模式一致。新增选择项需要遵守所属 listbox/tab 的键盘约定；普通导航继续使用浏览器按钮行为。
