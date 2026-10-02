# Agent Note: 显式选择开发后端

Status: implemented

## Problem

开发命令先完整编译再启动源码 fixture，增加等待；默认假 Provider 又容易让使用者把开发结果当作真实服务行为。

## Decision

开发入口必须明确选择临时 fixture 或已有 HTTP(S) 后端。fixture 直接运行源码并拥有临时数据生命周期；已有后端只被代理，不由开发命令启停。两者使用 Vite 热更新前端，不预构建。

## Alternatives considered

**隐式探测真实服务并回退 fixture：** 同一命令会因环境不同改变操作对象，难以判断是否产生真实会话。显式模式将选择放在命令中。

## Consequences

fixture 后端改动后重启开发入口；真实后端按生产构建流程更新。开发 fixture 用于界面行为，不证明原生 Provider 集成。构建预览仍由独立 preview 命令承担。

本条补充[开发资产交付](2026-09-19-versioned-development-assets.md)的本地入口；检索开发、预览和验证记录后，无现有决定需要完整替换。
