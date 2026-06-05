# Symphony TypeScript 实现：架构与开发过程

## 一、项目理解

Symphony 是一个**长期运行的自动化调度服务**。它的本质工作可以用一句话概括：

> 不断地从 issue tracker 中读取待做工作，为每个 issue 创建隔离的工作区，然后在该工作区内运行 coding agent 来完成工作。

更具体地说，它解决了以下四个运维问题：

1. **将 issue 执行变为可重复的守护进程工作流**——不再需要手动脚本或人工触发
2. **隔离 agent 执行环境**——每个 issue 有独立的工作目录，避免并发冲突
3. **版本化工作流策略**——`WORKFLOW.md` 文件随代码仓库版本管理，团队可以 review agent 的 prompt 和运行时配置
4. **可观测性**——结构化日志、HTTP API、Dashboard 让运维人员能看到每个 agent 在做什么

它**不是**一个通用的工作流引擎或分布式调度器。它是一个专注于 "读取 issue → 准备工作区 → 运行 coding agent" 这个特定循环的轻量级服务。

### 关键设计约束

- **Symphony 只读 tracker，不写**——issue 状态转换、评论、PR 创建等操作由 coding agent 自身通过工具完成
- **调度状态完全在内存中**——重启后通过重新拉取 tracker 状态恢复，不需要外部数据库
- **成功运行不一定意味着 issue "Done"**——工作流可以定义自己的交接点（如 "Human Review"）

## 二、整体架构

我将系统分为六个层次，每层有清晰的职责边界：

```
┌─────────────────────────────────────────────────────┐
│  CLI / HTTP Server        (入口 & 可观测性)          │
├─────────────────────────────────────────────────────┤
│  Orchestrator             (协调层)                   │
│  - poll loop                                        │
│  - dispatch / reconcile / retry                     │
├─────────────────────────────────────────────────────┤
│  Agent Runner             (执行编排)                 │
│  - workspace + prompt + multi-turn loop             │
├─────────────────────────────────────────────────────┤
│  Agent Backend            (agent 适配)               │
│  - Codex app-server (JSON-RPC over stdio)           │
│  - Claude Code (CLI subprocess)                     │
├─────────────────────────────────────────────────────┤
│  Tracker Client           (issue tracker 适配)       │
│  - Linear GraphQL                                   │
│  - (Jira / GitHub / GitLab 预留)                     │
├─────────────────────────────────────────────────────┤
│  Foundation: Config / Workflow / Workspace / Prompt  │
│             Types / Logger                          │
└─────────────────────────────────────────────────────┘
```

数据流方向是自上而下的：Orchestrator 驱动一切，Agent Runner 负责单个 issue 的执行逻辑，底层的 Backend 和 Tracker 提供具体的外部系统交互。

## 三、任务拆分策略

我采用了**自底向上、逐层构建**的开发顺序。核心原则是：每一步完成后代码都能通过类型检查，上层模块永远只依赖已经存在的下层模块。

### 开发顺序

```
Step 1: 项目脚手架 (package.json, tsconfig.json)
    ↓
Step 2: 领域模型 (types.ts) — 定义所有数据结构
    ↓
Step 3: 基础设施 (logger.ts) — 后续所有模块都需要日志
    ↓
Step 4: Workflow Loader — 从文件系统读取配置和 prompt
    ↓
Step 5: Config Layer — 解析 YAML front matter 为类型安全的配置对象
    ↓
Step 6: Linear Client — 实现 tracker 数据获取
    ↓
Step 7: Workspace Manager — 文件系统操作、路径安全、hooks
    ↓
Step 8: Prompt Builder — 模板渲染
    ↓
Step 9: Codex App Server Client — agent 协议实现
    ↓
Step 10: Agent Runner — 组合 workspace + prompt + agent 完成单次 issue 执行
    ↓
Step 11: Orchestrator — 调度循环（依赖以上所有模块）
    ↓
Step 12: HTTP Server & CLI — 入口和可观测性
    ↓
Step 13-16: 接口抽象重构 — 提取可插拔的 TrackerClient 和 AgentBackend
```

### 为什么这个顺序有效

- **类型先行**：`types.ts` 最先完成，后续所有模块共享同一套类型定义，避免接口不一致
- **无依赖→有依赖**：Logger、Workflow、Config 等没有外部依赖的模块先做，减少编码时的心智负担
- **先能编译再求正确**：每完成一个模块就运行 `tsc --noEmit`，确保类型安全贯穿始终
- **最后重构**：先用具体类型（LinearClient、AppServer）让系统跑通，确认接口边界后再抽象为 interface+factory

## 四、开发过程中的关键决策

| 决策点 | 选择 | 原因 |
|--------|------|------|
| 模板引擎 | LiquidJS | Spec 要求 "Liquid-compatible semantics"，严格模式支持 strictVariables/strictFilters |
| YAML 解析 | `yaml` (npm) | 轻量、零依赖、YAML 1.2 兼容 |
| HTTP 框架 | 原生 `node:http` | 只需几个端点，不值得引入 Express/Fastify |
| 进程通信 | `readline` over stdio | Codex app-server 使用 JSON line protocol，readline 天然适配 |
| 并发控制 | AbortController + Promise | 比 Worker Threads 简单，agent 执行是 I/O 密集非 CPU 密集 |
| 配置热更新 | `fs.watch` | 轻量，符合 spec 的 dynamic reload 要求 |
