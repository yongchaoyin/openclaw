# UI-TARS 视觉能力迁移计划（OpenClaw）

## 1. 背景与目标

本计划用于在 **OpenClaw 现有架构上** 新增视觉操作能力，按功能迁移 `UI-TARS-desktop` 的核心能力，而不是引入第二套独立系统。

目标能力（全量）：

- 大模型“看截图 + 决策下一步动作”
- operator 执行键鼠/浏览器动作
- 可控循环（loop 上限、间隔、重试、停止）
- 可观测（每轮输入/动作/结果可追踪）
- 安全治理（高风险动作管控、权限与数据边界）

约束前提：

- 远程官方 UI-TARS 服务停服日期为 `2025-08-20`，当前日期 `2026-02-23`，因此迁移按“本地/自建服务”路径设计。

明确范围：

- 本期 **不迁移移动端/ADB operator**，聚焦 Browser + Desktop + 可观测治理。

## 2. OpenClaw 当前可复用基线

## 2.1 浏览器动作能力已具备（高复用）

- OpenClaw 已有 `browser` 工具与动作路由，支持 `snapshot/screenshot/navigate/act` 等。
  - `src/agents/tools/browser-tool.ts`
  - `src/browser/routes/agent.snapshot.ts`
  - `src/browser/routes/agent.act.ts`
  - `src/browser/routes/agent.act.shared.ts`
- `act` 已覆盖 click/type/press/hover/drag/select/fill/resize/wait/evaluate/close。
  - `src/browser/routes/agent.act.shared.ts`
- 已支持 refs + 标注截图（`screenshotWithLabels`），天然适配“视觉定位 -> 执行动作”链路。
  - `src/browser/pw-tools-core.interactions.ts`

## 2.2 节点与远程执行能力已具备（可扩展）

- OpenClaw 已有 nodes 体系和 `node.invoke` 命令面，已有 camera/screen/system/browser.proxy。
  - `src/agents/tools/nodes-tool.ts`
  - `src/gateway/node-command-policy.ts`
  - `src/node-host/runner.ts`
  - `src/node-host/invoke.ts`
- 已有高风险命令 allowlist/denylist 与审批链路，可复用到视觉高风险动作。
  - `src/gateway/node-command-policy.ts`
  - `src/gateway/node-invoke-system-run-approval.ts`
  - `src/security/audit.test.ts`
  - `src/wizard/onboarding.gateway-config.ts`

## 2.3 模型图像输入链路已具备（高复用）

- 工具结果可返回 image block，并在进入模型前统一做图像限制与净化。
  - `src/agents/tools/common.ts`
  - `src/agents/tool-images.ts`

## 2.4 工具编排与策略链已具备（高复用）

- 工具统一由 `createOpenClawTools` 注册，可按策略控制可见性。
  - `src/agents/openclaw-tools.ts`
  - `src/agents/tool-policy.ts`
  - `src/agents/tool-policy-pipeline.ts`

结论：迁移重点应放在“视觉循环编排 + 桌面 operator 扩展 + 安全治理”，浏览器侧避免重复实现。

## 3. 迁移原则

1. 基于 OpenClaw 增量实现，不引入平行 runtime。
2. 优先复用已有 `browser` 与 `nodes` 能力，缺口最小化补齐。
3. 动作白名单化，禁止“任意系统能力”外溢。
4. 所有高风险动作纳入审批/策略控制。
5. 先达成稳定闭环，再扩展动作与平台。

## 4. 功能迁移映射（UI-TARS -> OpenClaw）

| UI-TARS 能力                         | OpenClaw 现状                         | 迁移策略                                  | 优先级 |
| ------------------------------------ | ------------------------------------- | ----------------------------------------- | ------ |
| 视觉 loop（截图->决策->执行）        | 无统一视觉循环引擎                    | 新增 `visual runtime`（复用现有工具调用） | P0     |
| Browser operator 动作                | 已有完整 browser act/snapshot         | 直接复用，做动作映射层                    | P0     |
| Desktop operator（点击/拖拽/热键等） | 仅 system.run，无桌面动作协议         | 在 node 侧新增 `desktop.*` 命令族         | P1     |
| ADB/mobile operator                  | 无 UI-TARS 同等动作协议               | 本期不迁移（显式排除）                    | N/A    |
| 上下文窗口（最近 5 图）              | 无视觉上下文管理                      | 在 visual runtime 增加窗口与截断策略      | P0     |
| loop 上限/节流                       | 有通用 tool-loop 检测，无视觉专用参数 | 增加 visual 专用参数与硬限制              | P0     |
| 重试策略（模型/截图/执行）           | 分散在各工具层                        | 在 visual runtime 统一配置与计数          | P0     |
| call_user / 人工介入                 | 有消息/会话工具                       | 用 `message` 或中断事件实现               | P1     |
| 报告与可观测                         | 有日志与会话体系                      | 增加 visual run 日志与回放索引            | P1     |
| 远程模式                             | 有 node/browser proxy                 | 采用 node 自建，不依赖官方远程服务        | P1     |

## 5. 目标架构设计（OpenClaw 内）

新增模块建议：`src/visual-agent/*`

- `runtime.ts`: 视觉执行状态机（start/pause/resume/stop）
- `planner.ts`: 模型调用与动作解析（OpenAI-compatible）
- `context.ts`: 截图窗口管理（默认最近 5 张）
- `dispatch.ts`: 动作分发（browser/desktop）
- `policy.ts`: 风险动作拦截与审批钩子
- `types.ts`: `VisualAction` 协议、运行参数、错误模型
- `reporter.ts`: 每轮 trace 记录与摘要输出

工具入口建议：

- 新增 `visual` 工具：`src/agents/tools/visual-tool.ts`
- 在工具注册中接入：`src/agents/openclaw-tools.ts`
- 在 tool display 中增加可读展示：`src/agents/tool-display.json`

配置入口建议：

- 新增 `tools.visual` 配置：
  - `enabled`
  - `maxLoopCount`（默认 100，范围 25-200）
  - `loopIntervalInMs`（默认 1000，范围 0-3000）
  - `context.maxImages`（默认 5）
  - `retry.model=5/screenshot=5/execute=1`
  - `targets.browser/desktop`
  - `safety.requireApprovalActions`
  - `data.screenshotUploadPolicy`
- 配置类型和 schema 更新：
  - `src/config/types.tools.ts`
  - `src/config/zod-schema.ts`
  - `src/config/schema.ts`
  - `src/config/defaults.ts`

## 6. 分阶段实施计划

## 阶段 0：契约与脚手架（1 周）

目标：先落地统一协议和配置，不实现全动作。

交付：

- `VisualAction` 协议与运行状态机 skeleton
- `tools.visual` 配置与 schema 校验
- `visual` 工具最小骨架（可触发单轮 dry-run）
- 文档草案与开发开关

验收：

- 配置校验通过，`pnpm build` 与测试通过
- 不影响现有 `browser/nodes` 行为

## 阶段 1：Browser 视觉闭环（P0，1-2 周）

目标：基于现有 browser 能力打通“看图决策执行”闭环。

范围：

- 感知：调用 `browser snapshot/screenshot` 获取当前可视状态
- 动作：映射到 `browser action=act/navigate`
- 循环：maxLoopCount/interval/context/retry/stop 全量生效
- 终止：支持 `finished` 与用户中止

实现要点：

- 优先使用 refs 模式，避免 selector 不稳定
- 在每轮写入结构化 trace（截图元数据、动作、结果、耗时）
- 错误统一分级：可重试/不可重试/人工介入

验收：

- 中等复杂网页任务可稳定完成
- 超限/重试/中断行为符合配置
- 失败可从 trace 复盘

## 阶段 2：Desktop Operator（P1，2 周）

目标：补齐 UI-TARS 桌面动作能力。

范围：

- 新增 node 命令建议：
  - `desktop.snapshot`
  - `desktop.act`（click/double_click/right_click/drag/type/hotkey/scroll/wait）
  - `desktop.status`（权限与可用性）
- 在 `nodes` 工具或 `visual dispatch` 中接入 desktop 执行后端
- 高风险动作接入审批策略（例如批量输入、热键链）

需要改动：

- `src/node-host/runner.ts`（能力声明）
- `src/node-host/invoke.ts`（命令分发）
- `src/gateway/node-command-policy.ts`（allowlist + dangerous 分类）
- `src/wizard/onboarding.gateway-config.ts`（默认 deny）
- `src/security/audit.test.ts`（风险审计规则）

验收：

- 单机/节点模式均可执行桌面动作
- 权限缺失（如 macOS 辅助功能/录屏）能给出明确错误
- 风险动作在策略关闭时不可执行

## 阶段 3：可观测与治理完善（P1，1 周）

目标：把视觉能力变成可长期运维的产品能力。

交付：

- visual run 历史查询与导出
- 关键指标：成功率、平均轮数、重试率、中断率
- 数据策略：截图保留/脱敏/清理策略
- 文档与运维手册

验收：

- 线上排障可依赖 run trace 完整复盘
- 数据与权限策略默认安全

## 7. 测试计划

单测：

- action 映射与参数校验
- loop 边界（maxLoopCount、interval、window、retry）
- 错误分级与熔断逻辑

集成测试：

- browser 端到端（snapshot -> act -> next loop）
- node desktop 命令链路（gateway -> node.invoke -> result）
- 风险动作 deny/allow 行为

回归测试：

- `browser` 工具既有行为不回归
- `nodes` 既有 camera/screen/system 命令不回归
- config schema 严格校验不破坏旧配置

## 8. 风险与缓解

风险 1：桌面动作权限与跨平台差异大  
缓解：先做 macOS + node 模式，Windows/Linux 后续分期；权限预检查前置。

风险 2：视觉循环导致成本与时延上升  
缓解：严格上下文窗口（默认 5 图）、循环预算、失败快速退出。

风险 3：高风险动作安全边界不清  
缓解：动作白名单 + gateway/node 双层策略 + 默认 deny。

风险 4：与现有 browser 工具重复建设  
缓解：明确“复用 browser act/snapshot，新增仅为 visual runtime 编排”。

## 9. 评审决策点（请你确认）

1. 是否接受先落地 **Browser 闭环（阶段 1）**，再做 Desktop（阶段 2）。
2. Desktop 动作后端优先是否定为 **node 模式**（而非 gateway 本机直接执行）。
3. 移动端/ADB 明确不在本期迁移范围，后续如需纳入需单独立项。
4. 默认数据策略是否采用“截图仅会话期保留 + 可配置持久化”。

## 10. 里程碑建议

- M1（阶段 0+1）：Browser 视觉闭环可用（可灰度）
- M2（阶段 2）：Desktop operator 可用（macOS 优先）
- M3（阶段 3）：可观测与治理完善

本计划执行顺序按“先复用现有能力、再补缺口”组织，确保风险和改动面最小化。
