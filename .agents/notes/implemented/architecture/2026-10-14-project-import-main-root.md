# Agent Note: 导入链接工作区时登记所属主工作区

Status: implemented

## Problem

将任意 Git 目录登记为项目会破坏项目路径等于主 Worktree 路径的约束，导致真实主工作区被列表误标为可删除的 linked 条目。用户选择 linked Worktree 时需要进入所属项目，无需先手动寻找主目录。

## Decision

Git 项目只以 Git 确认的真实主工作区根目录登记。选择 linked Worktree 根目录时解析到所属主工作区，再在串行导入流程中检查仓库归属并登记；主工作区已登记时返回原项目，返回的项目路径始终是主根。解析目标必须存在、可访问且仍属于同一仓库。仓库子目录和裸仓库拒绝导入，普通非 Git 目录保持直接导入；错误信息使用英文。不通过 Git 管理目录必须位于 `<project>/.git` 的假设判断身份。

列表派生再次检查项目是否确为主根，排除 Git 列表的主条目后才生成可删除的 linked 条目。错误的已有登记直接拒绝，不迁移为另一路径，移除后重新导入；目录规范化供 Provider 会话 cwd 使用的行为保持不变。

本记录补充[Worktree 管理](2026-09-20-git-worktree-management.md)的导入入口，原记录继续持有三层界面、派生目录、仓库唯一登记和删除安全边界；[显式磁盘清理](../feature/2026-09-21-delete-explicit-disk-cleanup.md)继续持有删除确认与主目录保护。没有需要完整替代或归档的记录。

## Alternatives considered

**拒绝 linked Worktree：** 可保持主根不变量，但要求用户自行定位主目录。解析到同仓库主根并复用登记可保持单一项目身份，接受文件浏览范围扩展到主目录和所属 Worktree 的代价。

**自动提升所有 Git 子目录或将 linked 根登记为独立项目：** 前者改变用户选定的子目录范围，后者重复仓库并破坏主根分类；只对明确选择的工作区根做归一化。

## Consequences

从 linked Worktree 导入后，项目名称、路径和默认主工作区来自所属主目录；用户仍从项目下选择 linked Worktree 打开会话，不自动新建会话。主根无法可靠解析或不可用时导入失败，不猜测替代目录。导入唯一性、无效目录拒绝及主条目不可删除由[项目根测试](../../../../src/server/worktrees/project-root.test.ts)和[Worktree 管理测试](../../../../src/server/worktrees/manager.test.ts)约束。
