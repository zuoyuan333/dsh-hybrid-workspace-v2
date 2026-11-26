import { rm, mkdir } from 'node:fs/promises';
import { tempHome, makeCtx, firePre } from './fake-ctx.mjs';
import { classifyLifecycle, normalizeMemory, sweepMemories, pinMemory, restoreMemory, remainingMs, endOfLocalDay } from '../lib/lifecycle.js';
import { rememberText, retrieve } from '../lib/memory.js';
import { createWorkspace } from '../lib/router.js';
import { buildContext } from '../lib/context.js';
import { normalizeState } from '../lib/store.js';

let fails = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) fails++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : ''));
};

const now = Date.now();

// 1) 规则分类
const p = classifyLifecycle('以后每次都用简体中文回答，不要再用英文', { role: 'user', type: 'fact', now });
ok('用户长期偏好归入全局档案', p.tier === 'profile' && p.scope === 'global' && p.pinned === true, JSON.stringify(p));
const scratch = classifyLifecycle('今天深圳天气怎么样', { role: 'user', type: 'question', now });
ok('强时效信息归入 scratch', scratch.tier === 'scratch' && scratch.validUntil > now && scratch.validUntil <= endOfLocalDay(now) + 1, JSON.stringify(scratch));
const ep = classifyLifecycle('示范门店收银机断线的排查步骤：先看 net.log 的 reconnect 记录', { role: 'assistant', type: 'fact', now });
ok('过程知识归入 episodic', ep.tier === 'episodic', JSON.stringify(ep));
const durable = classifyLifecycle('结论：收银机断线是 4G 心跳超时，修复方式是调整重连间隔', { role: 'assistant', type: 'decision', now });
ok('结论/决策仍是 durable', durable.tier === 'durable', JSON.stringify(durable));

// 2) 旧记忆只补字段，不给新 TTL
const legacy = normalizeMemory({ text: '旧记忆：收银机断线已修复', type: 'fact', source: 'v1-ledger', at: now - 10000 });
ok('旧记忆默认 durable/workspace', legacy.tier === 'durable' && legacy.scope === 'workspace' && legacy.pinned === false, JSON.stringify({ tier: legacy.tier, scope: legacy.scope }));
ok('旧记忆 validUntil 保持 null', legacy.validUntil === null && legacy.expiresAt === null, String(legacy.validUntil));
ok('旧记忆 source 保持字符串', legacy.source === 'v1-ledger', legacy.source);

// 3) 状态里的全局档案容器
const stateA = normalizeState({ profile: [{ text: '以后用中文回答', type: 'fact', source: 'manual' }] });
ok('state.profile 数组归一为全局档案', stateA.profile.length === 1 && stateA.profile[0].tier === 'profile' && stateA.profile[0].scope === 'global' && stateA.profile[0].pinned === true, JSON.stringify(stateA.profile[0]));
const stateB = normalizeState({ profile: { memories: [{ text: '称呼是小W', type: 'fact', pinned: false }] } });
ok('state.profile 对象形式兼容', stateB.profile.length === 1 && stateB.profile[0].tier === 'profile' && stateB.profile[0].pinned === false, JSON.stringify(stateB.profile[0]));

// 4) 过期只标记、不硬删，也不注入
const ws = createWorkspace('示范门店收银机断线');
ws.memories.push({
  id: 'm_expired', type: 'fact', text: '旧结论：收银机断线已修复', keys: ['收银机'], importance: 3,
  turn: 1, at: now - 1000, status: 'active', source: 'test', tier: 'durable', scope: 'workspace',
  pinned: false, validUntil: now - 1, expiresAt: now - 1, ttlMs: 0,
});
ok('过期记忆不参与检索', !retrieve(ws, '收银机', { now, k: 5, touch: false }).memories.some(m => m.id === 'm_expired'));
ok('懒清扫只标 expired', sweepMemories(ws, now) === 1 && ws.memories.length === 1 && ws.memories[0].status === 'expired', ws.memories[0].status);
ok('过期记忆不进上下文', !buildContext(ws, '收银机', { contextMaxChars: 2000 }, now).includes('旧结论：收银机断线已修复'));

// 5) 置顶覆盖 TTL；恢复给新期限
const m = ws.memories[0];
pinMemory([m], m.id, true, now);
ok('置顶恢复并永久有效', m.status === 'active' && m.pinned === true && m.validUntil === null && remainingMs(m, now) === null, JSON.stringify({ status: m.status, pinned: m.pinned }));
m.status = 'expired'; m.pinned = false; m.validUntil = now - 1; m.expiresAt = now - 1;
restoreMemory([m], m.id, now);
ok('恢复后重新给期限', m.status === 'active' && m.validUntil > now && remainingMs(m, now) > 0, String(m.validUntil));

// 6) 全局档案只写 state.profile，两个工作区都能注入
const profile = [];
const a = createWorkspace('收银机排障');
const b = createWorkspace('供应商对账');
const ops = rememberText(a, '以后每次都用简体中文回答，不要再用英文', { role: 'user', turn: 1, profile });
ok('全局档案写 profile 容器', ops[0]?.op === 'add' && profile.length === 1 && a.memories.length === 0, JSON.stringify(ops.map(o => o.op)));
rememberText(b, '请记住我的称呼是小W，以后都这样叫我', { role: 'user', turn: 1, profile });
ok('第二条全局档案也独立存放', profile.length === 2 && b.memories.length === 0, String(profile.length));
const textA = buildContext(a, '回答语言', { contextMaxChars: 2000 }, now, profile);
const textB = buildContext(b, '回答语言', { contextMaxChars: 2000 }, now, profile);
ok('两个工作区都注入全局档案', textA.includes('简体中文') && textB.includes('简体中文'), 'A=' + textA.includes('简体中文') + ' B=' + textB.includes('简体中文'));
ok('全局档案有独立标题', textA.includes('### 全局档案（跨工作区）'));

// 7) 插件接线：pre-step 写入全局档案，注入块包含它；snapshot 触发懒清扫
const home = tempHome();
process.env.DSH_HOME = home;
const { apply } = await import('../lib/index.js');
const ctx = makeCtx({ webServer: true });
const plugin = apply(ctx, { sweepIntervalMs: 0, debug: false, contextMaxChars: 2000 });
const agent = { session: { id: 's1', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } };
const section = await firePre(ctx, agent, '以后每次都使用简体中文回答，不要再用英文', 1, 1);
const snap = await plugin.snapshot();
ok('插件把全局档案放进 state.profile', snap.profile.length === 1 && snap.workspaces[0].memories.length === 0, JSON.stringify({ profile: snap.profile.length, wsMem: snap.workspaces[0].memories.length }));
ok('插件注入全局档案', section.includes('### 全局档案（跨工作区）') && section.includes('简体中文'));
ok('snapshot 暴露 ttlLeftMs 字段', Array.isArray(snap.profile) && snap.profile[0].ttlLeftMs === null, String(snap.profile[0]?.ttlLeftMs));

const live = plugin.state.workspaces[0];
live.memories.push({
  id: 'm_live_expired', type: 'fact', text: '临时旧结论：这条应该过期', keys: ['临时'], importance: 2,
  turn: 1, at: Date.now() - 1000, status: 'active', source: 'test', tier: 'durable', scope: 'workspace',
  pinned: false, validUntil: Date.now() - 1, expiresAt: Date.now() - 1, ttlMs: 0,
});
const snap2 = await plugin.snapshot();
ok('snapshot 触发懒清扫', snap2.workspaces[0].memories.find(m => m.id === 'm_live_expired')?.status === 'expired' && snap2.stats.expired >= 1, JSON.stringify({ expired: snap2.stats.expired }));
await plugin.flush();
const disk = JSON.parse(await (await import('node:fs/promises')).readFile(home + '/hybrid-workspace-v2/state.json', 'utf8'));
ok('状态落盘包含 profile', Array.isArray(disk.profile) && disk.profile.length === 1, String(disk.profile?.length));

// 8) 保存失败要可见；恢复后自动清除
const statePath = home + '/hybrid-workspace-v2/state.json';
await rm(statePath);
await mkdir(statePath, { recursive: true });
let saveFailure = null;
try { await plugin.flush(); } catch (error) { saveFailure = error; }
ok('保存失败会抛错', Boolean(saveFailure) && String(saveFailure.message).includes('状态保存失败'), String(saveFailure?.message));
const failedSnap = await plugin.snapshot();
ok('快照暴露保存失败', Boolean(failedSnap.saveError?.message) && Number(failedSnap.saveError?.at) > 0, JSON.stringify(failedSnap.saveError));
await rm(statePath, { recursive: true, force: true });
await plugin.flush();
const recoveredSnap = await plugin.snapshot();
ok('保存恢复后清除错误', recoveredSnap.saveError === null, JSON.stringify(recoveredSnap.saveError));

console.log(fails ? 'LIFECYCLE FAIL ' + fails : 'LIFECYCLE PASS');
process.exit(fails ? 1 : 0);
