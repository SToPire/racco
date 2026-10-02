# Agent Note: Worktree 文件标签保留轻量浏览状态

Status: implemented

## Problem

切换文件侧栏的 Worktree 会卸载文件视图，导致返回时丢失已打开标签与活动文件。

## Decision

Dock 按 Worktree 路径在页面内保存标签和活动文件定位，切换目录后按需重新读取内容，不保留所有目录的预览正文。目录从当前目录清单移除时释放对应状态；同路径重新创建也从空标签开始。此决策扩展[项目 Dock](2026-09-18-project-session-import.md)的浏览连续性，不改变[文件引用](2026-09-22-project-file-references.md)的目录边界；两份记录继续有效，没有完整替代的记录。

## Alternatives considered

**保持每个文件视图挂载：** 可保留状态，但也保留文件正文、目录树和订阅。浏览器持久化则增加陈旧路径清理与恢复语义，页面内的轻量状态已能解决临时切换。

## Consequences

跨 Worktree 返回时恢复标签和活动文件，而内容仍反映重新读取的当前磁盘状态。刷新页面会清空浏览状态，删除目录不会留下可恢复的旧标签。
