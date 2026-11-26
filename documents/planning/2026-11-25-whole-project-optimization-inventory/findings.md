# Findings & Decisions

## Requirements
- 用户要求盘点整个工程并列出可优化项；这是分析与建议任务，不代表授权实施这些优化。
- 既有同类文档为 `documents/bugfixes/2026-11-25-project-logic-risk-review.md`，最终应更新该文档并注明盘点日期。
- 仓库专属记忆检索 `~/.codex/memories/MEMORY.md` 未找到匹配项。

## Research Findings
- 仓库规模约 6.4k 行生产代码，核心 `lib/index.js` 约 1.7k 行、`lib/ui.js` 约 1.3k 行；其余模块覆盖路由、存储、记忆、上下文、执行器、迁移、生命周期和桌面客户端。
- 运行形态包括 DSH Cordis 插件（入口 `lib/index.js`）、本地面板/聊天页（`lib/ui.js`）、面板宿主桥接（`lib/client.js`）、macOS WKWebView 原生壳（`shell/macos/main.swift`）以及 profile 安装脚本。
- `package.json` 声明 ESM、Node 插件，无直接 dependencies，仅对 `@deepseek-ai/cordis` 声明 peer 范围 `>=4.0.2 <5.0.0`；`npm test` 对应 `node test/all.mjs`，另有 macOS build 脚本。
- 测试覆盖文件数量较多，含合成 fixtures；真实 DSH/provider、浏览器和 macOS 壳的验证不在既有项目逻辑风险报告的验证范围内。
- README 已明确若干运行边界：状态文件不支持多进程并发写、面板限定本机、工作区隔离是提示词级、路由/分段/记忆抽取为启发式。
- 工作树初始无用户代码改动；本次新增规划目录尚未提交。
- `lib/index.js` 的 `apply()` 同时承载配置/加载、日志和存档、路由/记忆、收件箱调度/生命周期、管理操作、事件钩子及面板挂载，表明主编排层职责集中；细分边界前需检查函数依赖与已存在模块接口。
- 状态保存已有 300ms debounce、单进程 save queue 和原子 rename；但 `store.appendJsonl()` 对决策/trace 只追加，`readJsonl()` 先全量读取文件再切尾，未见轮转/体积上限，属于长期磁盘与启动性能候选。归档流程在 `archiveWorkspace()`/`archiveMigrated()` 会裁到 `cfg.archiveKeep`，但快照 API 每次返回完整归档（含 turns/memories），而 UI 归档列表只展示元数据，存在可减少轮询响应体的空间。
- `loadOrMigrate()` 在损坏状态备份失败时忽略 copy error，仍保存空的新状态；这是极端文件系统错误下的已证实数据恢复风险，建议备份失败时停止覆盖并显式报错。
- 面板路由已对页面设置 `frame-ancestors 'self'`，API 校验 loopback remote address/Host/Origin，POST 仅收 JSON 且 body 限 8 MiB；需继续核对具体输入校验和用户数据渲染。
- 收件箱和导入等高影响操作已做若干限制：任务必须锁定工作区、串行/并发受限、超时/取消由执行器处理；导入限制 8 MiB 并对容量超限拒绝/回滚；工作区生命周期操作会检查任务锁。
- UI DOM 动态内容多数通过统一 `esc()` 后再拼到 `innerHTML`，尚未发现明显未转义用户字段；仍需抽查剩余渲染路径和错误提示。
- `snapshot()` 将完整 `state.archives`（每个归档保留快照内容）放进 API 响应；`lib/ui.js` 每 30 秒轮询并全量重绘，但归档卡片只展示归档元数据。可将归档列表改为摘要，点开时再取快照详情，降低持续传输和渲染成本。
- 版本升至 `2.6.3` 后，`test/load-check.mjs:20`、`test/ui-smoke.mjs:38`、`test/v23.test.mjs:191` 仍硬编码期待 `2.6.1`。按当前包与页面版本静态对照，这些断言已过期，完整 `npm test` 会因版本断言失败；应改为动态读取包版本或在发版时统一更新。未运行测试。
- `test/all.mjs` 确实串行包含多组核心测试（含路由、状态损坏、治理、执行器、UI smoke、负载检查等）；在已跟踪文件中未见 CI 工作流配置，建议增加自动回归门禁，避免版本更新和多模块修改使断言漂移。
- 状态保存失败风险更具体：`saveNow()` 捕获 `saveState()` 错误后只写日志，`flush()` 因此正常 resolve；管理 API 在 `await flush()` 后仍返回成功。磁盘满/权限/IO 错误时用户可能看到操作成功、重启后变更丢失，应让持久化失败可被调用方感知，并加重试/状态提示。（2026-11-26 更新：v2.6.4 已加入 `saveError`、`flush()` 报错和页面横幅。）
- `log()`/`trace()` 对异步 `appendJsonl()` 仅使用同步 `try/catch`，`void` 掉的 rejected Promise 不会被该 catch 捕获；文件系统写失败可能形成 unhandled rejection。建议显式 `.catch()`、单队列写入并限长轮转。
- `loadOrMigrate()` 的损坏文件 copy 失败被忽略后仍保存空状态；现有 `test/state-corrupt.test.mjs` 只覆盖备份成功场景，没有备份失败保护测试。（2026-11-26 更新：v2.6.4 已改为备份失败时停止覆盖，并补测试。）
- `scripts/install.mjs` 备份失败会被忽略；安装/卸载先改软链，再顺序直接写 profile `package.json` 和 `cordis.patch.yml`，任一步失败都可能留下半安装状态。建议 staging + 校验 + 原子替换/失败回滚，并将备份失败视为不可继续。
- `shell-os.js:isLoopbackShellUrl()` 校验回环主机和路径但没有 scheme 白名单；Swift app 入口会先筛选 `http://`/`https://` 参数，因此目前非 HTTP scheme 会被原生壳忽略并退出。现有测试没有覆盖这个 JS/Swift 规则差异，可统一 fail-fast 并测试 `file:` 等 scheme。
- `classify()` 把 `payload.signal` 传给 LLM stream，但插件层没有自己的超时/最大墙钟时间；响应性依赖宿主一定会提供有效 signal 或 provider 超时。可加插件侧 deadline 和确定性路由回退。
- `writeAtomic()`/目录创建没有显式文件 mode，默认受系统 umask 控制；状态与日志含用户文本/记忆。共享设备或自定义宽权限目录下，建议新建目录限制为 0700、数据和临时文件 0600，并审慎迁移已有权限（当前环境实际权限未检查）。
- 合成评估 `test/eval-synth.mjs` 已有 >=100 条 fixture 和路由 purity/cohesion 阈值，是现有优势；仍缺对宿主真实接口的合同验证与 provider timeout/取消的集成验证。
- `loadOrMigrate()` 只检查 `workspaces` 数组形状、不分支校验 `found.version`；`normalizeState()` 固定写回 `STATE_VERSION = 2`，因此较新 schema 被旧插件打开时，可能被旧字段映射后覆盖成 v2。应拒绝未知更高版本并保留原文件，显式迁移各已知版本。
- 版本字符串分别硬编码在 `package.json`、三个 UI 文本位置和多个测试断言；当前测试断言漂移已发生。建议以包版本生成 UI version，并让测试动态读取，而不是重复手改。
- 桌面 shell URL scheme 校验在 JS/Swift 两侧不一致；Swift 入口已有 HTTP(S) 前缀筛选，非 HTTP 参数会退出。建议统一规则并增加非法 scheme 测试，属于一致性加固项。
- 模块边界复核：当前域模块已将路由、记忆、迁移、生命周期、策略和执行器拆开，这是可保留的结构；最明显的继续拆分点是 `lib/index.js` 内 300 行左右的 `applyOp()` 命令分发、收件箱调度和生命周期协调，以及 `lib/ui.js` 的服务端路由与超长内嵌页面脚本。应保持 `index.js` 作为组合根，抽出命令/接口边界后用现有 fake context 测。

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| 只盘点、不改业务代码 | 用户只要求优化清单；实施需要之后确定范围 |
| 静态证据与运行时假设分开标注 | 本任务不要求启动服务或运行测试 |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| 初始化清理命令被策略拒绝 | 改用 `unlink` 清除临时 symlink 与 active pointer |
| 首次补全计划补丁与实际生成模板不匹配 | 重读生成文件并按实际骨架编辑 |

## Resources
- `documents/bugfixes/2026-11-25-project-logic-risk-review.md`
- `package.json`、README、`lib/`、`scripts/` 和项目其余源码（已检查）
- `lib/index.js`、`lib/store.js`、`lib/router.js`、`lib/memory.js`、`lib/executor.js`、`lib/ui.js`、`lib/client.js`
- `test/all.mjs` 及 `test/*.test.mjs`
