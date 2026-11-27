# v2 调研与设计记录

日期：2026-11-19。目标：为「单聊天框 + 多工作区上下文」找同类方案，归纳可借鉴的单点，再重构一版。2026-11-23 更新：补充多话题拆分、注入过滤、宿主插件去重、上下文迁移、v2.3.1 真实回放、v2.3.2 全量复查与 v2.3.3 面板关闭修复。2026-11-25 更新：入口两跳确认、统一收件箱 P1 预览与 v2.4.0；随后 P2 收件箱接入独立 DSH 子会话，版本升到 v2.5.0；再完成 P3 独立壳与工作区治理，版本升到 v2.6.0；v2.7.0 精简为移除原生壳、治理只给建议、收件箱与聊天页冻结为实验；v2.8.0 增加普通聊天两区会话隔离试点（默认仍为提示词隔离）。

## 1. 调研范围与结论

| 来源 | 关键做法 | 对 v2 的影响 |
| --- | --- | --- |
| Claude Projects | 每个 project 自带 instructions/files/memory，thread 从 project 上下文起步 | 「工作区」= 路由单元 + 范围 + 关键词 + 代表性问法 |
| ChatGPT Projects | chats/files/instructions 聚合；project-only memory；支持 branch | 工作区记忆只在本区检索，不跨区注入 |
| Mem0（arXiv 2504.19413） | extract → consolidate → retrieve；ADD/UPDATE/DELETE/NOOP；token 成本约 -90% | 记忆抽取后先判重/冲突，而不是无脑追加 |
| Zep / Graphiti（arXiv 2501.13956） | 时序知识图谱，事实带有效期、可 supersede | 同实体新结论把旧记忆标为 superseded |
| MemGPT（arXiv 2310.08560） | 主上下文 + 外部上下文分层，模型自行换入换出 | 只注入摘要/相关记忆，细节留给检索工具 |
| Generative Agents（arXiv 2304.03442） | 检索分 = recency + importance + relevance | 记忆排序三项加权 |
| A-MEM（arXiv 2502.12110） | Zettelkasten 式笔记，新记忆反过来演化旧记忆 | 记忆带 keys，合并时更新而不是复制 |
| MemOS（arXiv 2507.03724） | MemCube 统一记忆，带 provenance/version | 记忆保留来源轮次，便于追溯 |
| Anthropic, Effective context engineering | compaction、structured note-taking、just-in-time retrieval | 预算化装配 + 需要细节时 search_context/decompress |
| Anthropic, multi-agent research | 子代理独立上下文，压缩后交回主代理 | 物理隔离形态的参考（尚未启用） |
| Context Rot（Chroma, 2025-07） | 输入越长表现越差，退化不均匀 | 不把「窗口够大」当成「信息可用」 |
| Lost in the Middle（arXiv 2307.03172） | 长上下文中间信息利用率低，U 形 | 相关记忆放前面，最近对话放后面 |
| TextTiling / HyperSeg / Def-DTS | 词面凝聚度 / 无监督分割 / LLM 演绎分割 | v2 用轻量词面 + 迟滞，避免每轮调 LLM 分割 |
| Aurelio semantic-router | 预定义 route + 代表性 utterance + 相似度 | 工作区维护 exemplars，路由用字段加权 |
| Cline Memory Bank | 结构化 Markdown 跨会话保存项目上下文 | 不引入向量库，状态保持可读 JSON |
| LangGraph memory | semantic / episodic / procedural；thread 隔离 | 记忆类型 + turn 压缩成 episode |
| Roo Code Boomerang Tasks | 子任务独立 mode，完成后回摘要 | 与 B 方案同源，暂未实现 |

未采纳：向量数据库/嵌入（引入依赖与索引运维，当前规模 60 个工作区不需要）；Graphiti 式图数据库（重）；MemGPT 式让模型自行编辑记忆（不可控、成本高）；每轮 LLM 话题分割（延迟与费用）；把所有历史压到 5K（用户明确说没必要）。

## 2. 设计决策

### 2.1 路由：词面 IDF + 迟滞，LLM 只做兜底

工作区卡由 name / description / keywords / exemplars / memories / summary 组成，每个字段有不同权重（name 1、keywords .95、description .75、exemplars .6、memories .55、summary .45）。打分是「查询词的 IDF 命中字段权重 / 查询词总 IDF」，名称整名出现额外 +0.18。

迟滞规则（`lib/router.js`）：

- 无当前区：top 达到 `routeAccept` 或整名命中 → route；否则 new。
- 有当前区：top 是当前区且分数够、且有强证据（整名、≥2 个词、或实体命中）→ stay。
- 短句（<12 字）→ sticky。
- 候选领先不足 `switchMargin` → sticky-margin。
- 强信号（分数 ≥.5 且领先 ≥.3）→ 直接切。
- 其余要连续 `pendingSwitch=2` 条同候选才切；仍模糊才 `ask-llm`。

这样避免 v1 的两个毛病：单个泛词命中就换区；一条弱信号造成来回抖动。

### 2.2 记忆：分类型 + 合并 + supersede + 检索

类型：decision / fact / todo / question / episode。

- 抽取：按句切分，保留 8~320 字、含实体或结论/待办线索的句子；用户消息 ≥12 字也可入；助手长句 ≥16 字即使没有实体也收（避免漏掉「按单据号逐条核」这类叙述结论）。
- 合并：key Jaccard ≥.6 或文本相似 ≥.72 → NOOP；同类型新结论且 key 相似 ≥.34 → 旧记录 `status='superseded'`。
- 检索：0.55 相关度 + 0.2 新近度 + 0.15 重要度 + 0.1 类型先验，MMR 0.35 去重。
- 压缩：turns 超过 `compactAt=24` 时把较早的轮次压成一条 episode，保留最近 `keepTurns=12`。

### 2.3 上下文：预算内只装相关信息

`lib/context.js` 的顺序：工作区头（名字/id/范围/关键词/摘要/记忆计数）→ 本区相关记忆 → 未决事项 → 最近 4 轮 → 回答规则。

默认 2400 字符，超预算时按「最近对话最旧行 → 未决 → 记忆尾部」裁剪，头部和规则不裁。规则明确：只依据本区、缺细节用 `search_context`/`decompress`、用户新说法优先于旧记忆。

这对应 Anthropic 的 just-in-time retrieval 与 Context Rot 的结论：不要把「可能有用」的东西全塞进去。

### 2.4 状态与迁移

v2 状态在 `$DSH_HOME/hybrid-workspace-v2/state.json`，原子写 + 300ms 防抖。首次启动若 v2 不存在而 v1 存在，只读迁移：v1 ledger → decision/fact 记忆，保留 turns 轮次、会话绑定、归档。迁移测试断言 v1 文件逐字未改。

### 2.5 面板

不写 DSH 客户端 bundle：客户端插件是私有 `window.__ModuleLoader__` 格式，没有官方构建工具，手写有把前端启动搞挂的风险。改为宿主 webServer 直出自包含 HTML + JSON API，零前端依赖。

### 2.6 多话题：轻量拆段 + 每段独立路由

一条消息可能同时问几件事。v2 不把整条消息塞进一个区，而是先 `splitSegments()`：按空行、行首编号/项目符号、句末连接词（另外/还有/顺便/再问一个/另一个问题/第二个问题/第三个问题）切分；含三反引号代码围栏时整条不拆；短于 `segmentMinChars=12` 的碎片并入相邻段；最多 `multiTopicMax=3` 段，超出并入最后一段。

每段用一个临时会话视图（`{workspaceId:null,pending:null,recent:[]}`）独立跑 `decideRoute`，因此可以新建多个区或复用多个已有区。`session.activeWorkspaceIds` / `lastSegments` / `multiQuery` 记录本次涉及区，系统提示改用 `buildMultiContext()` 注入每区一张卡（总预算 `multiContextMaxChars=3000`，每区至少 700 字符），并附「多话题回答规则」。助手回答分发到所有活跃区，但记忆只写主区，避免一句话被复制多份。追问「第二个呢？」通过段序引用回到对应区。

取舍：不引入 LLM 分割，避免每轮多一次调用；拆错时面板可合并/改范围。代码围栏不拆，避免把一段代码里的空行误判成两个话题。

### 2.7 注入过滤：只认真实用户消息

DSH 里有些插件会把提示以 role=user 的消息注入（例如 dsh-ops 的 batching-guidance，source `dsh-ops:step-tail`）。早期 v2 把这些当用户输入，导致建出「Plugin context fro」工作区并污染记忆。修复：`INJECTED_PREFIX=/^\s*\[Plugin context from\b/iu` 与 `INJECTED_SOURCE=/(?:batching-guidance|dsh-ops:step-tail)/iu`；带这些标记的消息不参与路由、不 appendTurn、不 remember。面板也不显示这些轮次。

### 2.8 上下文构成与宿主插件去重

面板增加 breakdown：把注入块按工作区卡/相关记忆/未决事项/最近对话/回答规则统计字符，顶部显示总量与占比。这样不再依赖 dsh-context 的独立仪表板。

宿主侧同时移除两个重复插件：dsh-context（只做洞察，不做压缩；其上下文构成已并入本面板）与官方 experimental plugin market bundle（只提供空壳 Discover，dshmarket 才是完整社区市场）。两者都只从 profile 的 dependencies/bundles 移除，node_modules 保留，回滚只需加回并重启。

### 2.9 上下文迁移：先聊后建区

自动路由是自底向上的聚类：用户先随口聊了几句，内容落进已有区或新建的临时区；后来某个话题值得单独维护，才手动建区。v1/v2.1 只有整区 merge，无法「只搬这个关键词相关的那部分」。v2.2 增加 `lib/migrate.js`：

- 对来源的 turns / memories / exemplars 建 IDF，按查询词覆盖率打分；`mode=match` 取分数 ≥ `minScore`（默认 .34），`mode=all` 全选。
- 命中某轮任一条对话时，默认把同轮助手回答一起搬（`roundContext`），避免只带走问题不带走结论。
- 迁移前 `dryRun:true` 返回每个来源的命中/剩余数量、样本与分数；面板先预览再确认。
- 真正搬迁时按 role+text+at 去重对话、按 id 或规范化文本去重记忆；来源轮次映射到目标 `rounds+1` 起，来源轮次扣减，避免两边轮次号冲突。
- `archiveMode=auto` 只有来源被搬空才归档；`always` 总是归档；`never` 保留空来源。搬空的来源只存元数据（`restorable:false`、`migratedTo`），不提供恢复，避免原文重复注入；来源还有剩余内容时归档仍可恢复。
- `rebindSessions` 默认开：绑定在来源的会话、多话题活跃区、段引用全部改到目标区，用户不需要切 DSH 会话；下一轮注入目标区，路由器之后仍可再切走。
- 只动 `state.workspaces`，不动 `state.profile`；来源不能是目标；不调用 LLM，迁移匹配是词面的。

取舍：没有做「自动判断该不该建区」——建区是用户的组织决策，插件只提供低成本迁移；也没有做语义同义匹配，避免引入嵌入与索引运维。

## 3. 指标

### 3.1 合成问题离线回放

数据：`test/fixtures/synthetic-questions.json`，108 条（12 个主题 × 8 条 + 每主题 1 条重复），全部虚构门店与业务描述。

| 指标 | 结果 |
| --- | --- |
| 工作区数 | 11 |
| 最大区占比 topShare | .17 |
| 单例工作区 | 0 |
| 平均轮数 | 9.82 |
| cohesion | .199 |
| 12 组人工话题 purity | .97 |
| 12 组人工话题 spread | 1.1 |

解读：合成集上不再出现大量单例区，topShare 也被压到 .17；同一问题重复出现时全部回原区。purity .97 说明仍有一组话题会被相邻业务描述吸走，面板可手动合并/拆分。

### 3.2 合成话题

12 组话题、每组 3 条，共 36 条：同组同区 36/36，purity 1，spread 1，10 个工作区。仍会把「收银机断线」与「开机黑屏」、「门诊药房打印机」与「前台小票打印机」合并为同域区，面板可手动拆。

### 3.3 200 轮投影基准（v1 账本，供 v2 预算参考）

30 个植入事实、200 轮合成运维会话：

| 策略 | 累计 token | 末轮上下文 | 5 万 token 内可回读 |
| --- | --- | --- | --- |
| 全量历史 | 18.49M | 177,793 | 0% |
| 丢弃思考 | 14.95M | 142,507 | 8% |
| 粗暴截断 | 7.21M | 67,317 | 58% |
| 截断+关键行 | 5.45M | 50,024 | 100% |
| 账本投影 | 805K | 4,286 | 83% |

结论：全量历史在 200 轮时事实「还在」，但中位距离 11.3 万 token，模型实际用不上；v2 的 2400 字符预算比账本更小，必须靠结构化记忆与按需检索保真。该基准尚未对 v2 重跑。

### 3.4 多话题与过滤回归

- `test/segment.test.mjs`：空行、编号、连接词、短碎片、代码围栏、超上限、multiTopic=false。
- `test/filter.test.mjs`：三种注入形态不建区、不增轮、不注入；真实用户消息正常建区；助手侧注入文本不写入。
- `test/multi.test.mjs`：三话题空行消息建 3 区、`multiTurns=1`、注入含 `### 工作区 1/3`、编号回答拆分到 3 区且不整段复制、无编号回答只写主区、追问「第二个呢？」回到第二区。

### 3.5 v2.1 记忆生命周期回归

- `lib/lifecycle.js`：profile / durable / episodic / scratch 四层，TTL 与本地日界；过期只标记 `expired`，不硬删。
- `state.profile`：全局档案独立存放，不复制进工作区；两个工作区都能按相关度注入同一份档案。
- 旧记忆只补字段：默认 durable/workspace/pinned=false，`validUntil` 保持 null，避免升级后被 TTL 清掉。
- `test/lifecycle.test.mjs`：规则分类、旧记忆归一、过期不注入、懒清扫只标记、置顶覆盖 TTL、恢复续期、全局档案隔离、插件注入与落盘。

### 3.6 v2.2 上下文迁移回归

- `test/migrate.test.mjs`：纯函数层验证关键词命中 2 条对话（含同轮助手）+1 条记忆、剩余量、轮次重编号、来源轮次扣减、关键词合并；插件 API 层验证 dry-run 不落盘、部分迁移保留来源、目标累计、会话重绑、搬空来源归档为元数据、`restorable:false` 拒绝恢复、面板含新建/迁移入口。
- 扩展覆盖 `archiveMode=always`（来源有剩余也归档、快照可恢复）与 `never`（搬空也保留空来源、不产生归档）。未覆盖：迁移后再次回流的重复去重。

### 3.7 v2.2.1 审查回归

- `test/review.test.mjs`：损坏 v2 状态备份后直接空启动、不再回退旧 v1；高相似不同结论走 supersede、同结论复述才 noop；trim 不硬删决策；全局档案无容器时跳过；superseded 不能置顶/恢复；合并轮次偏移/去重/摘要；多话题上下文首尾卡与预算；`index.html` 面板 API 基址；迁移重复来源只 plan 一次；归档/删除解绑多话题；编号回答拆分；`profileKeep` 只归档未置顶档案。
- 全量 15 套件：core / router / memory / migration / autocreate / state-corrupt / segment / filter / multi / lifecycle / migrate / eval-synth / ui-smoke / load-check / review，全部 PASS。

### 3.8 v2.3 回归

- 每区策略：`lib/policy.js` 夹取 `contextMaxChars` 600–12000、`memoryInject` 0–20、`autoSwitch`；`lib/context.js` 合并策略与全局预算；`locked` 时不拆多话题、不自动切区。
- 可移植性：`lib/portable.js` 导出 JSON/Markdown（默认含 `state.profile`，`withProfile:false` 可关闭），导入重编工作区与记忆 id、重指向 supersede 链；全局档案按规范化文本去重后合并。
- 路由解释：`lib/router.js` 的候选带 `matched/coverage`，`decideRoute` 记录问句词、当前区分与分差；面板 trace 展开显示命中词和 how 原因。
- 迁移逐条勾选：`lib/migrate.js` 预览返回 `items` 与 `nearItems`；`exclude` 排除已选条目，`include` 补选低分候选；`nearFloor=min(minScore,max(.08,minScore-.26))`。
- 可选桥接：`ctx.inject(['costMeter'])`，无服务时 `snapshot.cost.available=false`；不在核心依赖里。
- 结论演变：`lib/timeline.js` 沿 `supersededBy` 串链，面板卡片展示旧结论划线 → 新结论。
- 真实状态回放（本地 `.local/`，不随仓库发布）：2026-11-23 样本为 17 个工作区/4 个会话/2043 条记忆。连续问句样本（无空行/编号/连接词）修复前只拆 1 段，加入问号边界后拆成 3 段；但三段仍因同域词面相似落到同一已有区，说明“拆开”和“分区”是两件事。迁移 query 命中 4 轮/8 记忆，排除一条后 3 轮/8 记忆，执行后来源/目标守恒；跨语言（中文“插件”对英文 plugin）仍然漏搬。
- 全量 17 套件（core / router / memory / migration / autocreate / state-corrupt / segment / filter / multi / lifecycle / migrate / review / regressions2 / v23 / eval-synth / ui-smoke / load-check）全部 PASS；另对面板内联脚本做 `new Function` 编译检查。

### 3.9 v2.3.2 复查回归

- P0：`lib/lifecycle.js` 的 `PROFILE_CUE` 去掉裸“一直/总是/以后/每次/默认”，只保留显式偏好表达；三条故障/陈述句实测回落 durable，真实偏好仍 profile/pinned。
- P0：`lib/memory.js` 的记忆 id 纳入 `role`，consolidate 先按 id 查 active 并 noop；不同工作区同文记忆在自动 id 上再拼 `ws.id`，避免跨区串写。
- P0：supersede 增加 `subjectConflict`：门店/订单/设备/版本等不同实体编号不互相取代；“接口超时是网络问题”与“接口超时是数据库连接池耗尽”同主语仍取代；“库存10/20”纯数值变化仍取代。
- P1：`lib/store.js` 去掉 turns/profile/archives 的静默 slice，加载时严格校验 object 且 `workspaces` 为数组；`lib/context.js` 按段裁剪（recent→open→memories→profile，再缩 summary/description/keywords），600 字符预算与头部计数实测一致；`buildContext` 支持 `touch:false`，snapshot 不再续期 TTL。
- P1：`lib/router.js` merge 与 `lib/migrate.js` apply 均按 `max(rounds,turns.length)` 续号，目标在前、来源偏移，去重保留目标；迁移只删真正搬走的条目并返回 skipped；预览 items/nearItems 不再截断。
- P1：`lib/segment.js` 编号要求空白且非数字，版本号“1.0/2.0”不再被剥成“0 版本”；`lib/index.js` 导入/恢复超容量直接报错、不静默归档；sweep 回收 7 天以上无有效绑定的旧会话；`lib/ui.js` sameOrigin 校验回环 remoteAddress + Host。
- P2：`lib/policy.js` 严格布尔与有限数；`lib/timeline.js` 按 supersededBy 指针顺序；`lib/ui.js` 后台标签跳过刷新并保留 details；`lib/portable.js` JSON/Markdown 补齐归档、置顶、恢复、来源、实体、重要性、创建/更新时间与编号，Markdown 多文档用空行连接、正文中的 `- 状态：` 不误判元数据；`package.json` 升 2.3.2、exports 加 `./lib/*`、`npm test` 指向 `test/all.mjs`。
- 复查期间又修：Markdown 取代链缺 id、`---` 分隔符污染正文、`normalizeMemory` 丢 archivedAt/archiveReason、跨区同文记忆 id 冲突、头部档案计数、600 预算被 800 抬回。
- 全量 17 套件（core / router / memory / migration / autocreate / state-corrupt / segment / filter / multi / lifecycle / migrate / review / regressions2 / v23 / eval-synth / ui-smoke / load-check）通过 `node test/all.mjs` 顺序执行，全部 PASS；面板内联脚本另做 `new Function` 编译检查。新增回归覆盖超容量导入/满额恢复/sweep、Markdown 取代链与多文档、归档元数据、实体冲突、openItems/pruneInactive、策略字符串 false、时间线指针顺序。

### 3.10 v2.3.3 面板关闭修复

- 面板被 Electron 拦截 `window.open` 后可能回落到主窗口；旧关闭逻辑无条件 `window.close()`，会关掉整个 DSH。现在只对具名小窗 `hybrid-workspace-panel` 执行 close，同窗回退到 `/`，并补了同窗不关窗口的回归。
- 全量 17 套件与面板内联脚本编译通过。

### 3.11 v2.4.0 入口两跳与收件箱预览

- 入口从「未命中就建区」改为两跳确认：没命中已有区且当前区可用时，先返回 `stay` 并把这条消息记为 `session.newTopic`；下一条在 30 分钟窗口内达到 `newTopicConfirm`（默认 0.12）才建新区。明确说“新项目/新工作区/另起一个”立即建区（`explicit-new`）；同名或同路径复用已有区（`duplicate-name`）；活跃工作区达到 `activeLimit`（默认 12）时回退当前区或最近更新区，不再无限建区。
- 两跳确认建区时，`takeRoundTurns` 把暂存在旧区的首条 user/assistant 轮次迁到新区，并同步减旧区轮次和命中；`session.newTopic` 在 `normalizeState` 中保留 `wsId/round/originTurn`，跨重启仍能完成第二跳。合并工作区时轮次按 user 轮计数，避免虚增。
- 多话题分支增加 `pickMultiTarget`：非当前候选在分数不足但命中两个以上身份词时，复用该区而不是强制 `multi-new`，避免 workbuddy 这类中等匹配被拆成新工作区。
- P1 统一收件箱：`state.inbox` 保存 queued/running/done/failed/cancelled；面板可写任务、手动锁定工作区、加入队列、运行下一个、顺序执行、取消、重试、删除、清空已结束。当前按 1.2 秒模拟出队，不调用 DSH 执行器，也不改写工作区上下文；界面固定标注“P1 预览”。
- 全量 19 套件（新增 entry / inbox）与面板内联脚本编译通过。

### 3.12 v2.5.0 P2 两区独立子会话

- 收件箱执行器从 1.2 秒模拟改为真实派发：每个任务创建一个独立 DSH 子会话（`agents.create`，`meta.origin='subagent'`、记录父会话与 delegationDepth），继承父会话的 provider/model/预设，任务用 `inject`（插件边界）+ `followup`（用户任务）投递。
- 调度改为跨区最多 2 并发、同区串行；`inboxExecutor=auto` 时缺 `agents`/`approval`（兼容 `userApproval` 别名）会明确失败并提示原因，`simulate` 仅保留为显式降级/测试路径，模拟结果标 `simulated=true`，不会伪装成真实完成。
- 子会话审批策略创建后立即设为 `never`，避免审批请求落进不可见的子会话；代价是需要审批的操作会失败，界面固定说明。结果只回写任务卡（`done/failed/cancelled`、子会话 id、可见文本），不改工作区 turns/记忆。
- 取消会 `agent.cancel('user')` 并立即标记 cancelled；超时（默认 10 分钟）主动取消并标 failed；`turn/end` 的 error/blocked/max-tokens 等不按完成处理；`inboxClear all` 会中断在跑子会话。
- `lib/executor.js` 只用 `ctx.get` 懒加载宿主服务，不 import DSH 内部包；`agents`/`agentPresets`/`approval` 均为内部服务，加载失败或版本不兼容时走明确失败，需 adapter 兜底。
- 全量 21 套件（新增 inbox-executor 与 governance）与面板内联脚本编译通过。

### 3.13 v2.6.0 P3 独立壳与工作区治理

- 面板新增工作区治理区：0 会话/0 对话/0 记忆且闲置 >=7 天的空壳、无会话且 >=30 天不活跃的工作区由 sweep 自动归档（reason `governance-empty` / `governance-stale`）；有收件箱任务在跑的区跳过。低活跃、同名重复、超过 `activeLimit` 的只进 review，必须手动勾选/确认，不自动合并或删除。
- 治理诊断在 `lib/governance.js` 纯函数；自动归档仍由 `lib/index.js` 的 `archiveWorkspace` 执行，归档是软删除，可恢复。`governanceApply` 只接受手动 ids，返回 archived/skipped。
- P3 独立壳：`/hybrid-workspace/shell` 复用同一面板页，API 基址回退到 `/hybrid-workspace/api`；`lib/shell-os.js` 只允许回环 `127.0.0.1/localhost/::1` 的 `/hybrid-workspace/shell`，原生 macOS 壳在 `shell/macos/main.swift`，用 `scripts/build-shell-macos.sh` 构建到 `$DSH_HOME/hybrid-workspace-v2/HybridWorkspaceShell.app`；未构建时面板明确提示并回退浏览器窗口。
- 独立壳默认是聊天式主界面：顶栏只保留「功能」一个入口，消息流展示当前工作区的收件箱任务与结果；原 header/main 管理面板整体移入 `#console-drawer` 抽屉，不复制功能。发送走 `inboxAdd` + `inboxRun all`，继续复用 P2 执行器与治理能力。1280x800 浏览器实测聊天页、抽屉、发送与完成回写通过；全量 21 套件与面板内联脚本编译通过。

### 3.14 v2.6.1 工作区按钮改为窗口内 iframe

- DSH 桌面端 `app.asar/lib/main.js:20278` 的 `setWindowOpenHandler` 会把 `http(s)` 的 `window.open` 交给系统浏览器并 `deny` 应用内窗口；系统浏览器没有 DSH 登录态，用户只会看到 `dsh web authentication required`。
- 主窗口实际加载 `dsh-app://app/`，不是 `http://127.0.0.1:<port>`；顶层 `window.location.assign` 在该自定义协议下仍无法稳定进入插件页，因此不再依赖导航。
- `lib/client.js` 改为在 DSH 窗口内追加全屏 `#hybrid-workspace-overlay`，主体 `iframe` 的 src 用 `new URL("hybrid-workspace/shell", window.location.href)` 解析到聊天页；顶栏保留「关闭」和「浏览器打开」（后者读 `__DSH_TRANSPORT__.streamBaseUrl`）。页面与 API 仍走 `dsh-app://app` 的同源转发。
- 面板检测 `window.self !== window.top` 时加 `embedded` class，隐藏自身的「关闭面板」与「独立壳」，避免 iframe 内导航到 DSH 根或触发非回环壳错误。
- `test/load-check.mjs` 断言 iframe 入口、完整地址解析、`__DSH_TRANSPORT__` 外开和禁止 `window.open(`；`test/ui-smoke.mjs` 断言 embedded 规则。Playwright harness 验证 overlay/iframe/关闭/外开链接；全量 21 套件通过。

### 3.15 v2.6.3 风险修复

- 收件箱任务只绑定到已映射该工作区的活跃根会话；必须有存在的绝对工作目录。派发前注入有字符上限的所选工作区上下文，不含全局档案，并在任务卡显示父会话与工作目录。
- 归档、清空、删除、合并、迁移、治理归档和容量淘汰均保护有排队/运行任务的工作区。运行时锁持续到子执行器完成取消收尾，即使任务卡已经标记取消或被批量清空。
- `hybrid` 默认关闭 LLM 路由；启用后只发送当前用户消息及最多 5 个候选的 ID/名称（当前区纳入候选集），不发送范围、示例、记忆和历史对话。`mode: "llm"` 仍表示明确选择 LLM 路由。
- 工作区容量达到上限且所有候选区都被任务锁定时，新话题不再继承旧区上下文；路由 trace 标记 `capacity-protected`，保留在途两跳话题候选供后续消息重试。
- 助手记忆来源轮次使用宿主 turn，与两跳建区中暂存的用户记忆采用同一轮次标识。
- 面板响应增加 `frame-ancestors 'self'`，保留同源 DSH 窗口 iframe；macOS 壳构建使用暂存目录，签名失败不再成功退出，并在中断或替换失败时尝试恢复旧应用。
- 本次只进行代码和文档复核及静态语法/差异检查；没有运行测试、DSH、浏览器或 macOS 构建，不能据此确认宿主集成行为或设备 UI。

### 3.16 v2.6.4 保存失败可见性与取消锁释放

- 状态保存失败不再静默：`flush` 抛错使变更 API 返回 500，snapshot 暴露 `saveError`；页面顶部显示红色横幅，保存恢复后自动清除。
- 状态文件版本高于当前支持的 schema 时拒绝加载并保留原文件，避免旧代码 normalize 后覆盖未来字段。
- 状态文件损坏且备份失败时抛出 `STATE_BACKUP_FAILED`，停止用空状态覆盖原文件；只有备份成功才重建。
- `waitForTurn` / `waitIdle` 同时响应截止时间和取消信号，turn 前取消立即释放收件箱并发锁与工作区锁，不再等到 `inboxTaskTimeoutMs`；超时与取消分别标记。
- `inboxRun all=false` 会清除上一轮的连续出队标志，避免非 all 调用后仍把同区队列自动泵完。
- 全量 21 套件通过，新增保存失败、备份失败、turn 前取消和保存横幅回归；面板内联脚本编译通过。

### 3.17 v2.7.0 精简：移除原生壳，治理只建议

- 移除原生 macOS 壳：删除 `lib/shell-os.js`、`shell/macos/main.swift`、`scripts/build-shell-macos.sh`，去掉 `openShell` op 和面板「独立壳」按钮；保留 `/hybrid-workspace/shell` 网页聊天页、DSH 窗口内 iframe 和「浏览器打开」兜底。
- 工作区治理不再自动归档：删除 `governanceEnabled` / `governanceAutoArchive` / `governanceSweepIntervalMs`、sweep 自动归档块和 `autoIds`；`report` 仍把空壳/长期无会话标为 `auto`（界面显示「可归档」），但所有归档与合并都必须手动确认。
- 收件箱与聊天页冻结为实验功能，不再扩展；保留 P2 子会话执行器和现有 UI，文案明确标注实验。
- 版本 2.7.0；全量 21 套件通过。

### 3.18 v2.8.0 普通聊天两区会话隔离试点

- 工作区策略新增 `isolation: 'prompt' | 'session'`，默认 `prompt`；只有 `isolationPilot` 中的工作区能启用 `session`，默认试点为 DSH 插件开发 `ws_59299832` 与华润餐饮 `ws_f66e8d8b`。
- 试点区启用后，`agent/pre-step` 在路由完成后接管首步：父会话手动写入 `step/start`、用户消息、子会话答案和 `step/end`，父模型不被调用；子会话由 `ctx.agents.create` 创建，`origin=subagent`、审批固定 `never`，只注入本区上下文（默认 2400 字符、4 条记忆）。
- 每个试点区最多一个子会话，同一父会话复用；父会话切换时会重建。插件 dispose、工作区归档/迁移/清空/删除/合并或策略切回 `prompt` 时销毁对应子会话；snapshot 暴露 `isolationPilot` / `isolationActive`。
- 创建失败（agents/approval 缺失、cwd 无效）返回 null，回退到原提示词隔离；子会话失败、超时或中断会写入明确错误并完成本轮，不会悄悄交给父模型。
- 只接管首步且只处理单话题消息；一条消息拆成多个话题时仍由父模型按编号统一回答，避免多个子会话并发争用父会话事件序列。
- 面板策略对话框只在试点区显示「会话隔离」选择器；卡片显示当前隔离方式。新增 `test/isolation.test.mjs` 覆盖策略门禁、接管事件顺序、子会话复用、失败回退和 dispose；全量 22 套件通过。
- 面板浮层顶栏改为可拖拽标题栏：设置 `data-window-drag` 和 `-webkit-app-region: drag`，交互按钮设置 `no-drag`；macOS 左侧预留 78px 红绿灯位置。真实窗口拖动需重启 DSH 后在桌面端验证。
- 工作区卡片的「策略」按钮从底部操作区移到标题行，并加主色样式和提示文案；长卡片无需滚到最底部才能设置隔离方式。

### 3.19 v2.8.1 管理面板收口，移除聊天壳

- 删除 `/hybrid-workspace/shell` 的聊天式页面与抽屉：移除 `#chat` 消息流、发送表单、`renderChat` / `initShell` 及相关监听，页面只保留管理 dashboard。
- 旧地址 `/hybrid-workspace/shell` 返回 302 到 `/hybrid-workspace/`；顶部「工作区」浮层 iframe 和「浏览器打开」兜底都改指向管理面板，不再尝试打开聊天页。
- 日常聊天仍走 DSH 原生输入框：插件在 `agent/pre-step` 路由、用 `systemPrompt.section` 注入工作区上下文，回复由 DSH 渲染；收件箱和执行器保留在管理面板，继续服务任务派发。
- 测试改为断言面板不含聊天壳、旧地址 302、重定向后仍是管理面板；README 同步说明管理面板是唯一入口。全量 22 套件通过。

### 3.20 v2.8.2 消息级改派

- 路由 trace 增加稳定 id、DSH turn 和来源工作区轮次；面板「最近路由判定」新增「纠正」列，选择目标区点「改派」即可把这一轮用户消息、同一轮回答和同轮记忆搬到目标区。
- 改派不是复制：来源区的这一轮被移除、来源正例被删除；目标区加上这次用户文本作为正例，后续同类消息更容易落到目标区；只重绑该 trace 所属会话，来源区其他会话不受影响。
- 保护：找不到记录、重复改派、同区改派、来源轮次已不在最近对话、来源或目标有排队/运行的收件箱任务都会拒绝并给出原因。
- trace 还记录完整用户文本的指纹；改派前核对来源轮次仍是同一条消息。来源区轮次号会被复用（例如改派后 rounds 回到 0，下一条又从 1 开始），只凭轮次号会把后来的一轮误搬走，指纹不一致时拒绝并提示重新发一条。
- 改派标记存 `state.reassignedTraces`（`state.json`），启动时按 trace id 合并回最近记录；`trace.jsonl` 保持追加日志，不改写旧行。因此重启后已改派的行仍显示目标区，重复改派保护也继续生效。
- 修复 `migrate.applyPlan` 的目标轮次基准：原以目标消息条数作为轮次，目标已有 2 条消息（1 轮）时会跳到第 3 轮；改为以实际最大 turn 与 rounds 的较大值为基准。
- 新增 `test/reassign.test.mjs`（28 条断言），覆盖长消息正例、收件箱锁、目标已有轮次不跳号、轮次复用拒绝、会话重绑、标记落盘和重启合并；全量 23 套件通过。

### 3.21 v2.8.3 工作区命名清洗

- 真实 104 条工单回放暴露：4 个工作区里有 3 个单条噪声区，最大的区名是 `imPOS 报障】 ▍涉及功能：其他`。原因是旧 `heuristicName` 先 `clean` 再按标点切，报障模板的换行被压平，第一行标签和元数据被拼进名字。
- `heuristicName` 现在先识别报障模板的 `故障描述/问题描述/故障现象/...` 行，只取该行；去掉 `收到运维问题：` 这类转述前缀，并在中文结论后的 `: 010500…`、`: 1` 等 ID 前收口；没有描述时回退 `imPOS 报障 · 涉及功能`，不再用模板标签当名字。
- JSON 片段（话题拆段或日志粘贴）取第一个字段名作为标签，而不是 `, "putin_price_num"` 这类标点；普通短句命名保持原行为，空文本回退 `未命名工作区`。
- 新增 `test/naming.test.mjs` 覆盖报障模板、转述前缀、ID 收口、功能回退、JSON 片段、普通短句、截断和建区；全量 24 套件通过。
- 对 105 条已脱敏问题做离线命名检查：含模板壳/JSON 标点的名字从 24 条降到 0 条，唯一名字从 62 增至 67；这是命名检查，不是路由准确率。
- 本次只改命名，不调路由阈值；真实 104 条仍是单域、无标注数据，不能用来报准确率。

## 4. 未解决

- **物理隔离（B 方案）**：主代理只路由，子代理带独立上下文回答并回摘要；DSH 侧需要 `ctx.subagents.startActivation` 或每区专用会话。面板无法替用户切会话，需客户端配合。见 `docs/plan-b.md`。P2 已实现：宿主内部 `ctx.get("agents").create` 为每区创建独立子会话，收件箱和 v2.8.0 普通聊天试点共用；加载失败会明确失败或回退，而不是伪造完成。它仍是内部服务，需要 adapter 与版本兼容兜底。P3 只替换界面壳，执行与存储仍留在 DSH；v2.7.0 已移除原生 macOS 壳，v2.8.1 已移除网页聊天页，仅保留管理面板，治理不再自动归档。
- **记忆抽取保真**：规则抽取会漏无关键词叙述；可用 LLM 抽取，但每轮多一次调用，暂不做默认。
- **跨进程并发**：state.json 无锁。
- **LLM 路由的真实收益**：离线测试 llmCalls=0，尚未在真实 DSH 会话中验证 `ask-llm` 的比例与准确率。
- **多话题拆段的准确率**：已有真实小样本回放（连续问句可拆到 3 段），但样本量小；同域多段仍会并到一个区，是否要“每段强制建区”是产品选择，不是拆段器能单独决定。代码围栏不拆，包含大段代码的消息会整条归一个区。
- **迁移的语义匹配**：目前只按 token/IDF，同义改写和跨语言会漏搬；真实回放已看到中文“插件”匹配不到英文 plugin。暂不引入向量/LLM：漏搬可用 `mode:"all"`、更宽关键词、预览逐条补选兜底；等真实漏搬样本积累到能评估收益后再考虑语义层。
- **迁移目标为空**：面板新建目标区后若取消预览，会留下一个空工作区；可手动归档/删除。

## 5. 复现

```bash
cd dsh-hybrid-workspace-v2
node test/all.mjs            # 24 个入口顺序执行
node test/all.mjs v23        # 只跑名字含 v23 的入口
```

调研原文与链接见对话记录；外部页面只作为设计参考，未复制代码。
