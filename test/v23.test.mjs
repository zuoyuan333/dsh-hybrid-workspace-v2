import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { agent, firePre, makeCtx, sleep, tempHome } from './fake-ctx.mjs';
import { buildTimeline } from '../lib/timeline.js';
import { normalizePolicy, contextCfgFor } from '../lib/policy.js';
import { toMarkdown, parsePortable } from '../lib/portable.js';
import { normalizeMemory } from '../lib/lifecycle.js';

let fails = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) fails++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : ''));
};

// ── 纯函数：策略归一、预算合并、时间线、Markdown 往返 ──
const p = normalizePolicy({ contextMaxChars: 400, memoryInject: 99, autoSwitch: false });
ok('策略夹取到合法范围', p.contextMaxChars === 600 && p.memoryInject === 20 && p.autoSwitch === false, JSON.stringify(p));
const c = contextCfgFor({ policy: { contextMaxChars: 900, memoryInject: 2 } }, { contextMaxChars: 2400, memoryInject: 8, contextMinChars: 800 });
ok('策略覆盖全局预算', c.contextMaxChars === 900 && c.memoryInject === 2 && c.contextMinChars === 800, JSON.stringify(c));
ok('字符串 false 能关掉自动切走', normalizePolicy({ autoSwitch: 'false' }).autoSwitch === false);
ok('数字 0 / no 能关掉自动切走', normalizePolicy({ autoSwitch: 0 }).autoSwitch === false && normalizePolicy({ autoSwitch: 'no' }).autoSwitch === false);
ok('未知布尔值回落默认 true', normalizePolicy({ autoSwitch: 'maybe' }).autoSwitch === true);
const t0 = Date.now();
const chain = buildTimeline({ memories: [
  { id: 'm_old', text: '旧口径：库存 10', type: 'decision', status: 'superseded', supersededBy: 'm_new', turn: 1, at: t0 - 1000 },
  { id: 'm_new', text: '新口径：库存 20', type: 'decision', status: 'active', turn: 2, at: t0 },
] });
ok('时间线串起旧结论到新结论', chain.chains.length === 1 && chain.chains[0].nodes.length === 2 && chain.chains[0].nodes[0].id === 'm_old', JSON.stringify(chain));
const chain3 = buildTimeline({ memories: [
  { id: 'm_a', text: '最初口径 A', type: 'decision', status: 'superseded', supersededBy: 'm_b', turn: 1, at: t0 - 3000 },
  { id: 'm_b', text: '中间口径 B', type: 'decision', status: 'superseded', supersededBy: 'm_c', turn: 2, at: t0 - 2000 },
  { id: 'm_c', text: '最新口径 C', type: 'decision', status: 'active', turn: 3, at: t0 },
] });
ok('时间线不重复生成子链', chain3.chains.length === 1 && chain3.chains[0].nodes.length === 3 && chain3.chains[0].nodes[0].id === 'm_a', JSON.stringify(chain3));
const chain4 = buildTimeline({ memories: [
  { id: 'm_first', text: '旧结论', type: 'decision', status: 'superseded', supersededBy: 'm_second', turn: 1, at: t0 },
  { id: 'm_second', text: '新结论', type: 'decision', status: 'active', turn: 2, at: t0 - 5000 },
] });
ok('时间线按指针而非时间戳排序', chain4.chains[0]?.nodes?.[0]?.id === 'm_first' && chain4.chains[0]?.nodes?.[1]?.id === 'm_second', JSON.stringify(chain4));
const md = toMarkdown([{ id: 'ws_md', name: '导出样例', description: '边界', keywords: ['断线'], summary: '', rounds: 1, turns: [{ role: 'user', text: '收银机断线', turn: 1, at: t0 }], memories: [{ id: 'm_md', type: 'fact', text: '断线先查 net.log', keys: ['断线'], status: 'active', tier: 'durable', scope: 'workspace', turn: 1, at: t0 }] }]);
const parsed = parsePortable(md);
ok('Markdown 导出可回读', parsed.workspaces.length === 1 && parsed.workspaces[0].turns[0].text.includes('收银机') && parsed.workspaces[0].memories[0].text.includes('net.log'), JSON.stringify(parsed.error || parsed.workspaces.length));
const mdTwo = toMarkdown([
  { id: 'ws_a', name: 'A 区', description: '第一区', keywords: ['A'], summary: '', rounds: 1, turns: [{ role: 'user', text: 'A 的最后一句', turn: 1, at: t0 }], memories: [] },
  { id: 'ws_b', name: 'B 区', description: '第二区', keywords: ['B'], summary: '', rounds: 1, turns: [{ role: 'user', text: 'B 的第一句', turn: 1, at: t0 }], memories: [] },
]);
const pTwo = parsePortable(mdTwo);
ok('Markdown 多文档不把分隔符读进正文', pTwo.workspaces.length === 2 && pTwo.workspaces[0].turns[0].text === 'A 的最后一句' && pTwo.workspaces[1].turns[0].text === 'B 的第一句', JSON.stringify(pTwo.workspaces.map(w => w.turns?.[0]?.text)));
const mdChain = toMarkdown([{
  id: 'ws_chain', name: '演变区', description: '', keywords: [], summary: '', rounds: 2,
  turns: [],
  memories: [
    { id: 'm_chain_old', type: 'decision', text: '旧口径：库存 10', turn: 1, at: t0 - 1000, status: 'superseded', supersededBy: 'm_chain_new', tier: 'durable', scope: 'workspace' },
    { id: 'm_chain_new', type: 'decision', text: '新口径：库存 20', turn: 2, at: t0, status: 'active', supersedes: 'm_chain_old', tier: 'durable', scope: 'workspace' },
  ],
}]);
const pChain = parsePortable(mdChain);
const cm = pChain.workspaces?.[0]?.memories || [];
const oldM = cm.find(m => m.text.includes('库存 10'));
const newM = cm.find(m => m.text.includes('库存 20'));
ok('Markdown 保留取代链', oldM && newM && newM.supersedes === oldM.id && oldM.supersededBy === newM.id, JSON.stringify(cm.map(m => ({ id: m.id, s: m.supersedes, b: m.supersededBy }))));
const nm = normalizeMemory({ id: 'm_arch', text: '归档记忆', status: 'archived', archivedAt: t0 - 1, archiveReason: 'trim' }, { now: t0 });
ok('normalizeMemory 保留归档元数据', nm.archivedAt === t0 - 1 && nm.archiveReason === 'trim', JSON.stringify({ archivedAt: nm.archivedAt, archiveReason: nm.archiveReason }));

const mdFull = toMarkdown([{
  id: 'ws_full', name: '完整导出', description: '边界', keywords: ['断线', '库存'], summary: '摘要', rounds: 2,
  hits: 7, createdAt: t0 - 2000, updatedAt: t0 - 1000,
  turns: [{ role: 'user', text: '收银机断线', turn: 1, at: t0 }],
  memories: [{
    id: 'm_full', type: 'fact', text: '库存盘点\n- 状态：这是正文\n下一步', keys: ['库存'], entities: ['门店A'],
    importance: 4, source: 'user', turn: 2, at: t0, status: 'archived', tier: 'durable', scope: 'workspace',
    pinned: true, createdAt: t0 - 3000, updatedAt: t0 - 2500, archivedAt: t0 - 1500, archiveReason: 'trim',
    pinnedAt: t0 - 1200, restoredAt: t0 - 900,
    origin: { sessionId: 'sess-1', turn: 2, role: 'user' },
    supersedes: '', supersededBy: '',
  }],
}]);
const parsedFull = parsePortable(mdFull);
const fw = parsedFull.workspaces?.[0];
const fm = fw?.memories?.[0];
ok('Markdown 保留工作区计数与关键词', fw?.hits === 7 && fw?.createdAt === t0 - 2000 && fw?.updatedAt === t0 - 1000 && fw?.keywords?.includes('库存'), JSON.stringify(fw && { hits: fw.hits, created: fw.createdAt, keywords: fw.keywords }));
ok('Markdown 正文里的“- 状态：”不被当元数据', String(fm?.text || '').includes('- 状态：这是正文') && fm?.status === 'archived', JSON.stringify(fm?.text));
ok('Markdown 保留来源/实体/重要性', fm?.source === 'user' && fm?.importance === 4 && fm?.entities?.includes('门店A'), JSON.stringify(fm && { source: fm.source, importance: fm.importance, entities: fm.entities }));
ok('Markdown 保留归档/置顶/恢复时间', fm?.archivedAt === t0 - 1500 && fm?.archiveReason === 'trim' && fm?.pinnedAt === t0 - 1200 && fm?.restoredAt === t0 - 900, JSON.stringify(fm && { archivedAt: fm.archivedAt, archiveReason: fm.archiveReason, pinnedAt: fm.pinnedAt, restoredAt: fm.restoredAt }));
ok('Markdown 保留原始来源链', fm?.origin?.sessionId === 'sess-1' && fm?.origin?.turn === 2 && fm?.origin?.role === 'user', JSON.stringify(fm?.origin));

const mdInjected = toMarkdown([{
  name: '注入测试', description: '', keywords: [], summary: '', rounds: 0, turns: [], exemplars: [],
  memories: [{
    id: 'm_inject', type: 'fact', text: '第一条', keys: ['a\n## 对话'], source: 'conversation\n# 全局档案',
    archiveReason: 'x\n# 全局档案', status: 'active', tier: 'durable', scope: 'workspace', turn: 1, at: t0,
  }],
}], { profile: [] });
const parsedInjected = parsePortable(mdInjected);
ok('Markdown 元数据不因换行注入新文档', parsedInjected.workspaces?.[0]?.memories?.length === 1 && parsedInjected.profile.length === 0, JSON.stringify({ ws: parsedInjected.workspaces?.[0]?.memories?.length, profile: parsedInjected.profile.length }));

// ── 插件：策略锁定、费用桥接、时间线、迁移排除、导出/导入 ──
process.env.DSH_HOME = tempHome();
const { apply } = await import('../lib/index.js');
const ctx = makeCtx({ webServer: true });
ctx.costMeter = {
  async getSessionCost (sid) {
    if (sid !== 's1') return { found: false };
    return { found: true, own: { cost: 0.0123, apiCost: 0.02, calls: 2, input: 100, output: 50, cacheRead: 10, cacheWrite: 0, reasoning: 0 } };
  },
};
const inst = apply(ctx, { debug: false, disableProcessHook: true, llmJudge: false, multiTopic: true });
const a = agent('s1');
const first = await firePre(ctx, a, '示范门店收银机断线，先查 net.log', 1);
await sleep(100);
await inst.flush();
let st = inst.state;
const wsId = st.sessions.s1.workspaceId;
ok('首条消息建立当前区', Boolean(wsId) && st.workspaces.length === 1, wsId);

const route = ctx.routes[0];
const server = createServer((req, res) => route.handler(req, res));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port + '/hybrid-workspace';
async function post (body) {
  const r = await fetch(base + '/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
}

try {
  const setPolicy = await post({ op: 'policy', id: wsId, policy: { contextMaxChars: 900, memoryInject: 1, autoSwitch: false } });
  ok('策略 API 返回 ok', setPolicy.status === 200 && setPolicy.json.policy?.autoSwitch === false, JSON.stringify(setPolicy.json));
  const section = await firePre(ctx, a, '会员积分接口改异步队列\n\n供应商对账差两毛三分', 2);
  await sleep(100);
  await inst.flush();
  st = inst.state;
  ok('locked 策略不拆出多个区', st.workspaces.length === 1, String(st.workspaces.length));
  ok('locked 策略整条留在当前区', st.sessions.s1.workspaceId === wsId && st.workspaces[0].rounds === 2, String(st.workspaces[0].rounds));
  ok('locked 策略清空多话题分段', st.sessions.s1.lastSegments.length === 0 && st.sessions.s1.multiQuery === '');
  ok('locked 策略仍注入当前区', section.includes('收银机') || section.includes('net.log'), section.slice(0, 60));

  const snap = await inst.snapshot();
  const card = snap.workspaces.find(w => w.id === wsId);
  ok('snapshot 暴露工作区策略', card?.policy?.autoSwitch === false && card.policy.contextMaxChars === 900 && card.policy.memoryInject === 1, JSON.stringify(card?.policy));
  ok('cost-meter 服务被桥接', snap.cost?.available === true && snap.cost.total.cost > 0, JSON.stringify(snap.cost));
  ok('会话行带费用', snap.sessions.some(s => s.sessionId === 's1' && s.cost?.found === true));

  st = inst.state;
  st.workspaces.find(w => w.id === wsId).memories.push(
    { id: 'm_old', text: '旧口径：库存 10', type: 'decision', status: 'superseded', supersededBy: 'm_new', turn: 1, at: t0 - 1000, tier: 'durable', scope: 'workspace' },
    { id: 'm_new', text: '新口径：库存 20', type: 'decision', status: 'active', turn: 2, at: t0, tier: 'durable', scope: 'workspace' },
  );
  await inst.flush();
  const snap2 = await inst.snapshot();
  const timeline = snap2.workspaces.find(w => w.id === wsId).timeline;
  ok('snapshot 暴露结论演变', timeline?.chains?.length === 1 && timeline.chains[0].nodes.length === 2, JSON.stringify(timeline));

  // 迁移预览逐条排除一条记忆
  st = inst.state;
  st.workspaces.push({
    id: 'ws_src3', name: '收银与积分杂项', description: '混合', keywords: ['收银机', '积分'], summary: '',
    turns: [
      { role: 'user', text: '收银机断线先查 net.log', turn: 1, at: t0 - 5000 },
      { role: 'assistant', text: '结论：4G 心跳超时', turn: 1, at: t0 - 4000 },
      { role: 'user', text: '会员积分改异步', turn: 2, at: t0 - 3000 },
      { role: 'assistant', text: '结论：先落队列', turn: 2, at: t0 - 2000 },
    ],
    memories: [
      { id: 'm_src_disc', text: '收银机断线根因是 4G 心跳超时', keys: ['断线'], type: 'decision', turn: 1, status: 'active', tier: 'durable', scope: 'workspace' },
      { id: 'm_src_int', text: '积分接口改为异步写入', keys: ['积分'], type: 'decision', turn: 2, status: 'active', tier: 'durable', scope: 'workspace' },
    ],
    exemplars: [], rounds: 2, hits: 0, createdAt: t0, updatedAt: t0,
  });
  st.workspaces.push({ id: 'ws_tgt3', name: '收银专项', description: '', keywords: ['收银机'], summary: '', turns: [], memories: [], exemplars: [], rounds: 0, hits: 0, createdAt: t0, updatedAt: t0 });
  await inst.flush();
  const dry = await post({ op: 'migrate', sourceIds: ['ws_src3'], into: 'ws_tgt3', mode: 'all', dryRun: true });
  const items = dry.json.plans?.[0]?.items || [];
  ok('迁移预览返回逐条 items', items.length === 6 && items.every(x => x.key && x.kind), String(items.length));
  const excludeKey = items.find(x => x.kind === 'memory' && x.text.includes('积分'))?.key;
  const moved = await post({ op: 'migrate', sourceIds: ['ws_src3'], into: 'ws_tgt3', mode: 'all', exclude: [excludeKey], dryRun: false, archiveMode: 'auto' });
  ok('排除一条记忆后仍迁移', moved.status === 200 && moved.json.moved?.turns === 4 && moved.json.moved?.memories === 1, JSON.stringify(moved.json));
  const src = inst.state.workspaces.find(w => w.id === 'ws_src3');
  const tgt = inst.state.workspaces.find(w => w.id === 'ws_tgt3');
  ok('被排除的记忆留在来源区', src?.memories?.length === 1 && src.memories[0].id === 'm_src_int', JSON.stringify(src?.memories));
  ok('未搬空的来源不归档', (moved.json.archived || []).length === 0);
  ok('目标收到四条对话一条记忆', tgt?.turns?.length === 4 && tgt?.memories?.length === 1);

  const exp = await post({ op: 'export', all: true, format: 'json' });
  const exported = JSON.parse(exp.json.content || '{}');
  ok('导出 JSON 含全部工作区', exp.status === 200 && exp.json.format === 'json' && exported.workspaces.length === inst.state.workspaces.length, String(exported.workspaces?.length));
  const imp = await post({ op: 'import', content: exp.json.content });
  ok('导入 JSON 建立工作区', imp.status === 200 && (imp.json.imported || []).length === exported.workspaces.length, JSON.stringify(imp.json.error || imp.json.imported?.length));
  ok('导入的工作区分到新 id', (imp.json.imported || []).every(x => !exported.workspaces.some(w => w.id === x.id)));

  const html = await (await fetch(base + '/')).text();
  ok('页面版本 v2.6.3', html.includes('v2.6.3'));
  ok('页面含导出/导入', html.includes('id="export"') && html.includes('id="import"') && html.includes('data-key'));
  ok('页面含策略与时间线', html.includes('data-op="policy"') && html.includes('结论演变'));
  ok('页面 trace 含命中词', html.includes('命中词') && html.includes('问句词'));
  ok('页面含迁移逐条预览', html.includes('openMigratePreview') && html.includes('取消勾选的会留在来源区'));
} finally {
  server.close();
}

// 没有 costMeter 服务时完全隐藏
process.env.DSH_HOME = tempHome();
const inst2 = apply(makeCtx({ webServer: false }), { debug: false, disableProcessHook: true, llmJudge: false });
const snap3 = await inst2.snapshot();
ok('无 cost-meter 时费用隐藏', snap3.cost?.available === false, JSON.stringify(snap3.cost));

await sleep(30);
console.log(fails ? 'V23 FAIL ' + fails : 'V23 PASS');
if (fails) process.exitCode = 1;
