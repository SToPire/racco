# Agent Note: 覆盖式面板使用原生模态焦点

Status: implemented

## Problem

窄屏详情和 Dock 在视觉上覆盖工作区，但普通侧栏仍允许焦点进入被遮住的会话；关闭时也可能丢失键盘操作位置。

## Decision

面板进入覆盖布局时使用原生 modal dialog，交给浏览器约束焦点与背景交互，支持 Escape 和关闭后返回触发点。宽屏停靠布局继续使用非模态 complementary 侧栏，不限制会话操作。此决策补充[项目 Dock](../feature/2026-09-18-project-session-import.md)和[轨迹定位](../feature/2026-09-22-trajectory-location.md)，不替代其查看与导航职责；部分替代[旧手机详情布局](2026-09-22-mobile-trajectory-controls.md)允许操作背景控件的取舍，手机先关闭详情再回答或停止，桌面局部详情继续并排操作。

## Alternatives considered

**全屏宽都使用模态：** 会阻断桌面并排阅读和输入。手写焦点循环与背景 inert 则重复浏览器能力，并增加嵌套面板、动态按钮和焦点恢复的维护负担。

## Consequences

键盘与辅助技术可以识别覆盖边界，背景控件不会意外取得焦点。布局跨过断点时，同一面板节点在非模态与模态之间切换，保留子组件状态与面板内焦点；关闭时恢复打开面板的触发点。文件标签等跨面板关闭需要保留的状态仍由外层拥有。
