# Agent Note: 明确安装与诊断服务运行环境

Status: implemented

## Problem

交互 shell 中的 Node 与全局 CLI 不等于 systemd 使用的程序；硬编码系统 Node 会让检查成功而真实服务无法启动。

## Decision

安装命令使用当前合格 Node 的绝对路径并记录明确 PATH，生成用户服务后仅重载定义，不自动启动或改变运行中的安装入口。doctor 分别报告 shell、已加载服务定义的二进制与 PATH，以及运行进程与定义的一致性。缺少 CLI 或 Node 不达要求时明确失败。

## Alternatives considered

**固定系统路径或依赖登录 shell 配置：** 前者排除常见用户级 Node 安装，后者使服务随不同登录环境漂移。明确保存本次安装选择，让更新成为有意操作。

## Consequences

Node 或 CLI 安装位置变化后需要重新安装服务定义；安装前需停止已有服务，避免改指安装链接时混用前后端。模板不能直接复制为可运行 unit，应通过安装命令生成。CLI 登录继续使用同一用户的原生账户状态，不把凭据写进 unit。
