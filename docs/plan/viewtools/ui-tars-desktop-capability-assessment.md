# UI-TARS-desktop 功能评估（用于 OpenClaw 视觉操作能力迁移）

## 1. 目标与范围

本文评估仓库 `"/Users/yongchao/Code/UI-TARS-desktop"` 的可用功能与工程边界，目标是为 OpenClaw 的“看截图 + 决策动作 + 执行动作”能力迁移提供评审依据。

评估范围：

- 产品与用户可见能力
- 动作与 operator 体系
- 端到端执行链路
- 运行边界（循环、重试、上下文、环境、模型、数据）
- 迁移分级与 MVP 实施建议

## 2. 结论摘要

UI-TARS-desktop 是一个视觉驱动智能 RPA 框架：每轮截图感知当前界面，由 VLM 生成下一步动作，再由 operator 执行键鼠/浏览器/ADB 操作并循环。

核心结论：

- 它是“有限动作集合 + 截图感知 + 受控循环”的执行器，不是任意系统能力平台。
- 桌面与浏览器动作体系成熟，可直接借鉴动作协议与执行循环。
- 边界设计明确：有循环上限、间隔、截图窗口、重试与环境约束，适合中等复杂度可视化任务。
- 远程官方服务在 **2025-08-20** 停服（当前日期 **2026-02-23**，该日期已过），迁移需以本地/自建服务为主。

## 3. 功能地图（按模块）

### 3.1 Agent 与编排

- `GUIAgent` 提供主循环：截图 -> 调模型 -> 解析动作 -> 执行 -> 更新状态 -> 下一轮。  
  证据：`/Users/yongchao/Code/UI-TARS-desktop/packages/ui-tars/sdk/src/GUIAgent.ts`
- 运行状态支持 `start/pause/resume/stop`，并暴露 `onData/onError` 回调。  
  证据：`/Users/yongchao/Code/UI-TARS-desktop/packages/ui-tars/sdk/src/GUIAgent.ts`

### 3.2 桌面操作（Computer Operator）

- 基于 NutJS operator 执行桌面输入动作（点击、拖拽、输入、热键、滚动等）。  
  证据：`/Users/yongchao/Code/UI-TARS-desktop/packages/ui-tars/operators/nut-js/src/index.ts`

### 3.3 浏览器操作（Browser Operator）

- 浏览器动作集覆盖页面点击、输入、滚动、导航、拖拽、热键与等待。  
  证据：`/Users/yongchao/Code/UI-TARS-desktop/packages/ui-tars/operators/browser-operator/src/browser-operator.ts`
- 存在 RemoteBrowserOperator 远程模式实现。  
  证据：`/Users/yongchao/Code/UI-TARS-desktop/packages/ui-tars/operators/browser-operator/src/browser-operator.ts:815`

### 3.4 移动设备操作（ADB Operator）

- 提供安卓设备动作执行（点击、滑动、输入、滚动、热键等）。  
  证据：`/Users/yongchao/Code/UI-TARS-desktop/packages/ui-tars/operators/adb/src/index.ts`

### 3.5 配置与观测

- 设置文档涵盖 provider、循环参数、报告与事件上报。  
  证据：`/Users/yongchao/Code/UI-TARS-desktop/docs/setting.md`
- Quick Start 明确环境依赖（单屏、浏览器要求）与远程服务说明。  
  证据：`/Users/yongchao/Code/UI-TARS-desktop/docs/quick-start.md`

## 4. 动作集合评估

### 4.1 桌面动作（NutJS）

支持动作（代表项）：

- `left_click`
- `double_click`
- `right_click`
- `drag`
- `type`
- `hotkey`
- `scroll`
- `wait`
- `finished`
- `call_user`

证据：

- `/Users/yongchao/Code/UI-TARS-desktop/packages/ui-tars/operators/nut-js/src/index.ts:37`
- `/Users/yongchao/Code/UI-TARS-desktop/apps/ui-tars/src/main/store/types.ts:10`

### 4.2 浏览器动作（Browser Operator）

除通用动作外，额外有：

- `navigate`
- `navigate_back`

证据：

- `/Users/yongchao/Code/UI-TARS-desktop/packages/ui-tars/operators/browser-operator/src/browser-operator.ts:230`

### 4.3 结论

动作边界是“白名单动作协议”，可预测、可治理；这非常适合在 OpenClaw 中做安全可控的视觉执行层。

## 5. 端到端执行链路

1. operator 获取截图（含 scale 信息）  
   证据：`/Users/yongchao/Code/UI-TARS-desktop/packages/ui-tars/sdk/src/GUIAgent.ts`
2. 模型调用（OpenAI-compatible），传入任务与图片上下文  
   证据：`/Users/yongchao/Code/UI-TARS-desktop/packages/ui-tars/sdk/src/Model.ts:260`
3. 动作解析（action parser，含坐标/参数规范化）  
   证据：`/Users/yongchao/Code/UI-TARS-desktop/packages/ui-tars/action-parser/src/actionParser.ts`
4. 执行动作（operator.execute）  
   证据：`/Users/yongchao/Code/UI-TARS-desktop/packages/ui-tars/sdk/src/GUIAgent.ts`
5. 进入下一轮或结束

## 6. 边界与约束（关键数值）

### 6.1 循环与节流

- `maxLoopCount`：默认 **100**，范围 **25-200**  
  证据：`/Users/yongchao/Code/UI-TARS-desktop/apps/ui-tars/src/main/store/setting.ts:20`，`/Users/yongchao/Code/UI-TARS-desktop/apps/ui-tars/src/main/store/validate.ts:24`
- `loopIntervalInMs`：默认 **1000ms**，范围 **0-3000ms**  
  证据：`/Users/yongchao/Code/UI-TARS-desktop/apps/ui-tars/src/main/store/setting.ts:20`，`/Users/yongchao/Code/UI-TARS-desktop/apps/ui-tars/src/main/store/validate.ts:24`

### 6.2 上下文窗口

- 截图历史默认最多保留最近 **5** 张  
  证据：`/Users/yongchao/Code/UI-TARS-desktop/packages/ui-tars/shared/src/constants/vlm.ts:5`，`/Users/yongchao/Code/UI-TARS-desktop/packages/ui-tars/sdk/src/utils.ts:58`

### 6.3 稳定性与重试

- 模型调用重试：**5** 次
- 截图重试：**5** 次
- 执行重试：**1** 次  
  证据：`/Users/yongchao/Code/UI-TARS-desktop/apps/ui-tars/src/main/services/runAgent.ts:217`

### 6.4 环境限制

- Browser Operator 前提：本机可用 Chrome/Edge/Firefox
- 文档明确多显示器可能失败，建议单屏  
  证据：`/Users/yongchao/Code/UI-TARS-desktop/docs/quick-start.md:9`

### 6.5 模型与数据边界

- 接口是 OpenAI-compatible，provider 配置不当会影响动作解析  
  证据：`/Users/yongchao/Code/UI-TARS-desktop/docs/setting.md:52`，`/Users/yongchao/Code/UI-TARS-desktop/packages/ui-tars/sdk/src/Model.ts:260`
- 截图和对话会发送到所配置模型服务端（除纯本地模型部署）  
  证据：`/Users/yongchao/Code/UI-TARS-desktop/packages/ui-tars/sdk/src/Model.ts:225`

### 6.6 远程模式边界

- 远程模式由远程服务决定模型/执行策略，不是本地任意替换
- 官方远程服务停服日期：**2025-08-20**（截至 **2026-02-23** 已过期）  
  证据：`/Users/yongchao/Code/UI-TARS-desktop/apps/ui-tars/src/main/services/runAgent.ts:181`，`/Users/yongchao/Code/UI-TARS-desktop/docs/quick-start.md:55`

## 7. 对 OpenClaw 的迁移分级

### 7.1 可直接复用（高优先）

- Agent loop 机制（状态机、重试、节流）
- 动作协议抽象（action_type + 参数结构）
- action parser 设计思路（坐标归一化/缩放处理）

建议：优先抽象为 `openclaw` 内部统一 `VisualAction` 协议，避免渠道特化分叉。

### 7.2 需要适配重写（中优先）

- operator 具体实现层（需要对接 OpenClaw 现有节点、权限、日志系统）
- UI 配置层（OpenClaw 现有 CLI/Gateway 配置模型与 UI-TARS 设置模型不一致）
- 观测上报（UTIO/report 需对接 OpenClaw telemetry）

### 7.3 不建议直接迁移（低优先）

- 紧耦合官方远程服务的远端模式实现
- 与 OpenClaw 已有能力重复且依赖重的远程 Browser 方案

## 8. 推荐 MVP 迁移路径

### 阶段 1：本地桌面视觉执行闭环（最小可用）

- 输入：任务文本
- 感知：截图
- 决策：VLM 输出受限动作
- 执行：本地桌面 operator（click/type/hotkey/scroll/wait/finish）
- 控制：max loop、interval、重试、人工中止

验收标准：

- 能稳定完成中短链路桌面任务
- 全链路日志可追踪每一轮截图与动作

### 阶段 2：浏览器动作扩展

- 增加 `navigate/navigate_back/drag` 等浏览器动作
- 补充浏览器环境探测与单屏校验提示

验收标准：

- 任务在常见站点可稳定完成，失败可回溯

### 阶段 3：安全与治理强化

- 高风险动作审批（例如连续热键、批量输入）
- 任务预算与超时策略
- 数据外发与隐私开关（截图上送策略）

验收标准：

- 能在默认安全策略下长期运行，不影响主系统稳定性

## 9. 评审建议（给迁移决策）

建议评审时先决策三件事：

1. 是否接受“受限动作白名单”作为 OpenClaw 视觉执行的硬边界。
2. 是否只做本地/自建模型与执行，不依赖官方远程模式。
3. 是否将视觉执行作为独立能力模块（与渠道逻辑解耦），避免后续技术债。
