# Task Plan: Whole project optimization inventory

## Goal
盘点整个工程的架构、业务流程、依赖、稳定性与维护成本，形成有代码依据和优先级的优化清单并更新既有风险分析文档。

## Next Step
任务完成；优化项已归档到既有工程风险报告。

## Current Phase
Phase 5

## Phases

### Phase 1: 工程结构与范围确认
- [x] 确认盘点目标、约束和现有风险分析文档
- [x] 盘点目录、入口、脚本、依赖及运行形态
- [x] 将发现记录到 findings.md
- **Status:** complete

### Phase 2: 关键逻辑与风险检查
- [x] 检查请求处理、状态持久化、并发与错误路径
- [x] 检查安全边界、输入校验和配置/安装流程
- [x] 用模块边界、耦合和复杂度视角复核
- **Status:** complete

### Phase 3: 优化项归纳
- [x] 按优先级、收益和改动范围归纳候选项
- [x] 区分静态证据与待运行验证的假设
- **Status:** complete

### Phase 4: 文档复核与交付
- [x] 更新既有工程风险分析文档，不另建重复文档
- [x] 复核建议证据、优先级和可执行性
- [x] 记录静态检查范围和未覆盖的运行时验证
- **Status:** complete

### Phase 5: 汇报
- [x] 汇总最值得优先推进的优化项
- [x] 说明文档位置、改动范围和验证限制
- **Status:** complete

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| 只盘点并更新既有风险分析文档，不顺带改业务代码 | 用户要求列出优化项；实施范围应由后续选择确定 |
| planning-with-files 默认路径通过临时 symlink 映射到 `documents/planning/` | 遵守项目要求，规划文件只保存在 `documents/planning/<task-id>/` |

## Errors Encountered
| Error | Resolution |
|-------|------------|
| 首次清理临时路径的命令被命令策略拒绝 | 改用 `unlink` 清理，未留下仓库根规划目录 |
| 首次计划文件补丁未匹配生成模板内容 | 重新读取初始化文件后按其实际骨架更新 |
