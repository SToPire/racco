# Agent Note: HTTP 与 WebSocket 共用可信入口

Status: implemented

## Problem

各读取与变更端点重复检查 Origin，部分路由未覆盖；Origin 与请求 Host 相等也不能独立证明 Host 受信任。单用户服务需要明确本机、Tailscale 和代理入口的边界，避免监听地址、请求来源和身份保护混为一谈。

## Decision

在路由和插件之前安装统一入口检查，覆盖 HTTP、静态资源和 WebSocket 升级。独立配置准确的 allowedHosts，默认只信任 loopback 主机名和 IP；监听地址不自动扩大列表。存在 Origin 时要求 HTTP(S) 来源与请求 Host 的主机名和端口一致，拒绝跨站 Fetch Metadata；缺少 Origin 的本机工具仍受 Host 检查。不信任 forwarded 头来扩展边界，HTTPS 代理需保留外部 Host。

[部署文档](../../../../docs/remote-access.md)明确远程地址必须显式配置，网络与身份保护由本人 SSH、Tailscale ACL 或认证代理承担。允许列表不是登录机制，不加入 RBAC 或多租户权限。本记录新增请求入口所有权；相关[Worktree 文件归属](2026-09-20-git-worktree-management.md)与[原生历史归属](../simplification/2026-09-17-session-state-without-turn-ledger.md)继续约束已受理请求的资源访问，没有完整替代的记录。

## Alternatives considered

**继续按路由比较 Origin 与请求 Host：** 重复逻辑容易漏掉新端点，而且两者同为陌生域名时缺少独立可信锚点。

**从监听地址或 forwarded 头推断可信 Host：** 通配监听不代表信任所有域名，代理头也需要额外的可信代理链配置。明确列举外部主机名并保留 Host 更适合当前单用户部署。

**增加服务内登录和多用户授权：** 当前产品授权单位仍是本人机器用户；这需要独立产品需求，不能由来源检查顺带引入。

## Consequences

新增端点自动继承同一来源边界，未知 Host 即使匹配 Origin 也会被拒绝。反向代理和 Tailscale 配置必须同步列出实际外部主机名；本机与开发端口无需逐个登记。能直达服务并构造可信 Host 的非浏览器客户端仍拥有用户级能力，所以远程入口的认证或网络隔离不可由 Host 允许列表替代。
