# Agent Note: 内核持有状态目录实例锁

Status: implemented

## Problem

排他创建锁文件与写入身份之间存在空文件窗口，另一实例会把它误判为失效锁并删除，导致两个 daemon 同时管理同一状态目录。SQLite 写锁不能保护会话所有权和临时图片清理。

## Decision

依据项目的 [Linux 支持范围](../../../../AGENTS.md#supported-platform--linux-only)，状态目录使用内核 `flock` 独占锁。daemon 持有锁文件的打开描述符直到状态关闭，关闭或进程退出时由内核释放；锁文件始终保留，任何实例都不得通过删除文件来回收锁。锁覆盖范围继续遵守[临时图片生命周期](../feature/2026-09-27-ephemeral-chat-images.md)的清理与关停顺序。

## Alternatives considered

**对空文件直接拒绝并保留 PID 身份文件：** 能堵住未写入窗口，但崩溃恢复仍需自行协调身份检查与删除，继续承受竞争和 PID 重用问题。

**增加原生 Node 锁依赖：** 同样能提供内核互斥，但现有 Linux 工具链已使用 `flock`；继承打开描述符即可持锁，无需引入编译依赖。

## Consequences

实例所有权与描述符生命周期一致，崩溃恢复不再依赖锁文件内容或删除。运行环境必须提供 `flock`，工具缺失或锁操作失败时启动拒绝继续；持锁期间不能删除或替换状态目录与锁文件。确定性交错及崩溃后的互斥保证由[真实进程回归测试](../../../../src/server/state/database.test.ts)覆盖，生产子进程的整体终止仍由 systemd 负责。
