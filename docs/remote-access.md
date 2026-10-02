# 访问边界与远程入口

Racco 是运行在本人 Linux 用户下的单用户服务。能访问服务的客户端可读取项目文件、发现原生会话、启动工具执行和删除会话。服务没有登录页或多用户权限系统；远程入口的访问保护由 SSH、Tailscale ACL 或已认证的反向代理负责。

## 本机与 SSH

默认 `host` 为 `127.0.0.1`、`port` 为 `7331`，只监听 IPv4 loopback。浏览器打开 `http://127.0.0.1:7331`；`localhost` 也属于默认可信 Host。需要远程访问时，可以保持服务只监听 loopback：

```sh
ssh -N -L 7331:127.0.0.1:7331 user@linux-host
```

随后打开本机的 `http://127.0.0.1:7331`。本地端口可以更换；可信 Host 匹配主机名/IP，不限制端口，但浏览器 Origin 必须与请求 Host 的主机名和端口一致。Vite 的随机本地端口也按此规则工作，代理需保留浏览器 Host 和 Origin。

## 显式可信 Host

`racco.config.json` 的 `allowedHosts` 默认是：

```json
["127.0.0.1", "localhost", "[::1]"]
```

配置该字段会替换默认列表。每项只能是准确的主机名或 IP，IPv6 使用方括号；不接受通配符、协议、端口或路径。监听地址 `host` 只决定绑定哪个网络接口，不会自动加入允许列表，也不会提供身份认证。

所有 HTTP 路由、静态资源和 WebSocket 升级共用入口检查：Host 必须在允许列表中；存在 Origin 时只接受与请求 Host 同一主机名及端口的 HTTP(S) origin；`Sec-Fetch-Site: cross-site` 被拒绝。命令行客户端可以不发送 Origin，仍需可信 Host。这是浏览器来源和主机名边界，不是网络身份认证。

## Tailscale 直连

按本机实际的 Tailscale IP 和 MagicDNS 名称设置，例如：

```json
{
  "host": "100.64.0.10",
  "port": 7331,
  "allowedHosts": ["100.64.0.10", "my-linux.example-tailnet.ts.net"]
}
```

通过 Tailscale ACL 仅允许本人设备或其他明确受信任且拥有同等机器权限的用户连接。绑定具体 Tailscale 地址可以避免同时监听其他网卡；该地址必须存在才能启动。`http://100.64.0.10:7331` 与该 MagicDNS 名称都可用。希望保留本机 loopback 访问时，可继续绑定 loopback 并用可信代理转发，而不是假设一个监听地址覆盖所有接口。

## HTTPS 反向代理

让 Racco 保持 `127.0.0.1:7331`，在已认证的 HTTPS 代理上暴露例如 `https://racco.example.com`：

```json
{
  "host": "127.0.0.1",
  "port": 7331,
  "allowedHosts": ["127.0.0.1", "localhost", "racco.example.com"]
}
```

代理必须保留外部请求的 `Host`（含非默认端口）及浏览器 `Origin`，并转发 WebSocket Upgrade。TLS 可以在代理终止，因此同名的 HTTPS Origin 可通过到后端 HTTP 监听器。Racco 不依据 `Forwarded` 或 `X-Forwarded-Host` 扩大允许范围；代理若把 Host 改为上游地址，却保留外部 Origin，会收到 403。HTTP 和 WebSocket 必须经过相同的认证与访问限制，后端端口不要另行开放。

修改配置后按部署流程重启 `raccod.service`。无需增加通配 Host、关闭来源检查或授予多个用户服务内角色。
