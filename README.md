<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/racco/racco-logo-dark.svg">
    <img src="assets/brand/racco/racco-logo.svg" alt="Racco" width="280">
  </picture>
</p>

<p align="center"><strong>Agent 多端协作控制台</strong></p>

## Demo

<table>
  <tr>
    <th>桌面</th>
    <th>手机</th>
  </tr>
  <tr>
    <td width="76%"><img src="assets/demo/desktop.jpg" alt="Racco 桌面端：项目列表、会话与 Agent 执行过程"></td>
    <td width="24%"><img src="assets/demo/mobile.jpg" alt="Racco 手机端：查看和继续同一段对话"></td>
  </tr>
</table>

## 为什么做 Racco

随着 Agent Harness 成为日常开发工具，指挥和监控 Agent 的需求也延伸到了手机上。Racco 关注两个问题：

- **远程入口分散**：不同厂商的远程方案与各自生态绑定，客户端迭代和网络访问条件也会影响使用体验。需要一个统一入口，集中管理不同 Harness 的会话。
- **终端不适合小屏**：通过 PTY 直接呈现 CLI 界面，终端布局和交互方式难以适配手机。移动端需要适合阅读、触控和快速回复的界面。

## 核心能力

- **多端操作**：响应式 WebUI，在电脑上开始任务，在手机上查看进度、继续对话、回复问题或中断执行。
- **统一接入**：前后端分离，通过 Codex App Server 与 Claude Agent SDK 封装统一 Agent 驱动，按项目管理、新建或导入原生会话。
- **过程可视化**：统一流式消息、工具调用和子 Agent 轨迹的事件表达，在对话与执行轨迹视图中查看任务如何推进。

## 对话历史

打开会话只加载最近 10 轮，向上滚动或点击“加载更早的消息”继续读取；子 Agent 的历史在选中时加载。Codex 使用 App Server 的原生 `thread/turns/list` 分页，需要支持该实验性接口的 Codex；Claude 首次仍读取完整原生历史，后续从 daemon 已有内存中分页，不建立持久化副本或轮次索引，也不改变数据库 schema。

Claude 在原生客户端修改的历史需点击“刷新历史”重新读取；daemon 重启后首次打开也会重新读取。历史分页限制轮数，不截断单轮中的大段工具输出。

## Worktree

需要 `git`：每个项目下可以并行多个 Worktree，列表实时来自 `git worktree list`，因此终端里手工建的 Worktree 也会出现。Racco 自己创建的 Worktree 放在 `~/.local/share/racco/worktrees/<项目>-<路径摘要>/`，可在 `racco.config.json` 里用 `worktreeRoot` 改到别处（该项只约束创建位置，不影响列表）。

安装步骤把本检出软链到 `~/.local/share/racco`，因此默认的 Worktree 落点位于本检出内，已在 `.gitignore` 中忽略。在本检出中清理时请用 `git clean -df`，**不要**用 `-x`——它会连同这些 Worktree 一起删掉。

列表不会自动刷新：在 Racco 之外改动 Worktree 后，点项目行的刷新按钮。
