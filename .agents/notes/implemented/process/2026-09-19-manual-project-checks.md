# Agent Note: 手动执行项目检查

Status: implemented

## Problem

项目需要保留统一的验证入口，同时按维护者要求取消仓库内的 GitHub 自动检查工作流。

## Decision

仓库不提供 GitHub Actions 工作流，开发者手动运行 `npm run check` 完成项目验证。检查脚本及本地报告输出继续保留。完整门禁禁止 Playwright 独占用例，并记录 Node 与浏览器执行和跳过数量；缺少用例统计不能算通过。静态组件测试只保留可访问性和状态语义，不锁定 SVG 几何、CSS 类名或属性顺序。本记录持有验证触发方式，与[开发资料的版本控制边界](2026-09-19-versioned-development-assets.md)互补，不替代其资料收录约定。

## Alternatives considered

**保留 push 和 PR 自动检查：** 能自动提供验证结果，但不符合维护者取消该工作流的要求。

## Consequences

推送和 PR 不再自动运行项目检查或上传报告；维护者需要主动执行检查并查看本地结果。
