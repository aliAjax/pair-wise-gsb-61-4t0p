# 汽车型式认证证据包审阅与补件平台

用于按车型、配置、法规项目和维护版本组织测试报告、部件清单、软件版本及豁免材料的本地认证工作台。

## 技术栈

- Nuxt 3 + TypeScript
- Nuxt UI
- Pinia
- Nuxt Router
- ofetch
- TanStack Query for Vue

## 主要工作区

- `/`：认证项目列表、关键词/状态/机构/风险筛选和项目统计
- `/projects/new`：建立车型、配置、维护版本和软件版本基线
- `/projects/[id]`：证据审阅、法规覆盖、状态流转、版本差异、共享引用、历史提交包冻结和审计
- `/ledger`：共享报告引用账（源头换版/撤回、项目引用登记、源账批次同步与恢复、成环/丢失来源检测、发布闸门）
- `/regulations`：按法规分类查看项目证据覆盖
- `/supplements`：跨项目批量补件
- `/reminders`：证书和证据到期提醒
- `/audit`：跨项目审批时间线与提交包导出

## 共享报告引用账规则

多个车型可共用同一份电池包试验报告，每个认证项目各留一份引用登记（`ReportReference`：报告版本 + 覆盖配置）：

- **失效重算**：源头报告换版（`superseded`）或撤回（`withdrawn`）后，仅受影响配置的证据自动转为 `resubmit` 并记录失效配置；其他项目与未受影响配置仍为有效证据。项目重新登记到新版本后恢复。
- **时间点一致**：法规完整性与审批阻断按当前时间点实时计算；历史提交包在冻结时刻固化法规快照、报告版本和证据指纹，源头后续换版/撤回不回改。
- **批次同步幂等**：源账以完整引用批次同步；失败时整批不落账但保留批次，可从保留批次恢复重试；已应用批次重复同步直接跳过，不反复回退。
- **发布闸门**：引用成环（dependsOn 有向图 DFS）或来源丢失时列出完整链路并停住提交/批准。

纯逻辑位于 `services/reference-ledger.ts`，场景测试见 `tests/reference-ledger.test.ts`（53 项断言）。

## 本地运行

```bash
npm install
npm run dev
```

访问 `http://localhost:18461`。

## 构建与检查

```bash
npm run typecheck
npm run test:ledger
npm run build
```

项目没有后端服务，使用结构化模拟数据，并通过 Pinia 和浏览器 `localStorage` 持久化车型项目、证据状态、版本、共享引用账和审计记录。ofetch 由本地模拟 fetch 适配器承载，TanStack Query 负责项目索引查询和筛选缓存。
