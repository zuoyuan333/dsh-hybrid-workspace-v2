import { createServer } from 'node:http';
import { tempHome, makeCtx, agent, firePre, fireAssistant, sleep } from './fake-ctx.mjs';
import { addExemplar } from '../lib/router.js';

process.env.DSH_HOME = tempHome();
const mod = await import('../lib/index.js');

let fails = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) fails++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (detail ? '  [' + detail + ']' : ''));
};

const ctx = makeCtx({ webServer: true });
const plugin = mod.apply(ctx, { debug: false, disableProcessHook: true, sweepIntervalMs: 0 });
await plugin.snapshot();

const a = agent('session-reassign');
const longText = '收银机断线排查：' + '示范门店四台收银机每天下午四点断线，net.log 里 reconnect 记录对不上，先按门店和终端号逐条核对。'.repeat(12);
await firePre(ctx, a, longText, 1);
await fireAssistant(ctx, a, '结论：先看 net.log 的 reconnect，再核对 session 表；这是单轮验证。');
await sleep(50);
await plugin.flush();

let snap = await plugin.snapshot();
const tr = snap.trace.find(t => t.sessionId === 'session-reassign' && t.wsId && Number(t.round) > 0);
ok('路由记录带稳定 id', Boolean(tr?.id?.startsWith('tr_')), JSON.stringify(tr));
ok('路由记录带文本指纹', /^[0-9a-f]{16}$/.test(tr?.textHash ?? ''), String(tr?.textHash));
const sourceId = tr?.wsId;
const source = plugin.state.workspaces.find(w => w.id === sourceId);
ok('来源轮次有用户与回答', (source?.turns ?? []).length === 2, JSON.stringify(source?.turns));
addExemplar(source, longText);
plugin.state.sessions['session-other'] = {
  workspaceId: sourceId, routedAt: Date.now(), pending: null, lastQuery: '旧问题', lastTurn: 1, recent: [],
};

const route = ctx.routes[0];
const server = createServer((req, res) => route.handler(req, res));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port + '/hybrid-workspace';
const post = async payload => {
  const r = await fetch(base + '/api', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  return { status: r.status, json: await r.json() };
};

try {
  const created = await post({ op: 'create', name: '供应商对账差异', description: '供应商对账与发票差异' });
  ok('创建目标工作区', created.status === 200 && Boolean(created.json.id), JSON.stringify(created.json));
  const targetId = created.json.id;

  let r = await post({ op: 'reassign', traceId: 'tr_missing', into: targetId });
  ok('拒绝不存在的路由记录', /找不到这条路由记录/.test(r.json.error || ''), JSON.stringify(r.json));
  r = await post({ op: 'reassign', traceId: tr.id, into: sourceId });
  ok('拒绝改回原工作区', /不能改派到原来的工作区/.test(r.json.error || ''), JSON.stringify(r.json));
  r = await post({ op: 'reassign', traceId: tr.id, into: 'ws_missing' });
  ok('拒绝不存在的目标', /目标工作区不存在/.test(r.json.error || ''), JSON.stringify(r.json));

  plugin.state.inbox.push({ id: 'q_reassign_lock', text: '锁定目标区', workspaceId: targetId, status: 'running' });
  r = await post({ op: 'reassign', traceId: tr.id, into: targetId });
  ok('目标区有收件箱任务时拒绝改派', /目标工作区有排队或运行中的收件箱任务/.test(r.json.error || ''), JSON.stringify(r.json));
  plugin.state.inbox = plugin.state.inbox.filter(t => t.id !== 'q_reassign_lock');

  r = await post({ op: 'reassign', traceId: tr.id, into: targetId });
  ok('改派成功', r.status === 200 && r.json.ok === true, JSON.stringify(r.json));
  ok('搬走用户消息与同一轮回答', r.json.moved?.turns === 2, JSON.stringify(r.json.moved));

  snap = await plugin.snapshot();
  const src = plugin.state.workspaces.find(w => w.id === sourceId);
  const tgt = plugin.state.workspaces.find(w => w.id === targetId);
  ok('来源不再保留这一轮', !(src?.turns ?? []).some(t => String(t.text).startsWith('收银机断线排查')), JSON.stringify(src?.turns));
  ok('来源轮次扣减', Number(src?.rounds) === 0, String(src?.rounds));
  ok('目标收到用户与回答', (tgt?.turns ?? []).filter(t => String(t.text).startsWith('收银机断线排查') || String(t.text).startsWith('结论：先看 net.log')).length === 2, JSON.stringify(tgt?.turns));
  ok('目标轮次从 1 开始', Number(tgt?.rounds) === 1 && (tgt?.turns ?? []).every(t => Number(t.turn) === 1), JSON.stringify(tgt?.turns));
  ok('来源正例已移除', !(src?.exemplars ?? []).some(e => String(e?.text ?? e).includes('收银机断线排查')), JSON.stringify(src?.exemplars));
  ok('目标记住正例', (tgt?.exemplars ?? []).some(e => String(e?.text ?? e).startsWith('收银机断线排查')), JSON.stringify(tgt?.exemplars));
  ok('当前会话已改绑目标', plugin.state.sessions['session-reassign']?.workspaceId === targetId, JSON.stringify(plugin.state.sessions['session-reassign']));
  ok('其他会话仍留在来源', plugin.state.sessions['session-other']?.workspaceId === sourceId, JSON.stringify(plugin.state.sessions['session-other']));
  ok('trace 标记改派目标', snap.trace.find(t => t.id === tr.id)?.reassignedTo?.id === targetId, JSON.stringify(snap.trace.find(t => t.id === tr.id)));
  ok('快照不再记录来源轮次', !(snap.workspaces.find(w => w.id === sourceId)?.turns ?? []).some(t => String(t.text).startsWith('收银机断线排查')), '');

  r = await post({ op: 'reassign', traceId: tr.id, into: targetId });
  ok('同一条记录不能重复改派', /已经改派到/.test(r.json.error || ''), JSON.stringify(r.json));

  // 模拟标记丢失后来源区复用了第 1 轮：不能把后来这一轮误当成旧 trace 搬走。
  const savedMark = plugin.state.reassignedTraces[tr.id];
  delete plugin.state.reassignedTraces[tr.id];
  delete tr.reassignedTo;
  source.rounds = 1;
  source.turns = [{ role: 'user', text: '来源区后来复用第 1 轮的新消息：供应商发票抬头写错了。', turn: 1, round: 1, at: Date.now() }];
  r = await post({ op: 'reassign', traceId: tr.id, into: targetId });
  ok('轮次被复用后拒绝误改派', /来源这一轮已经变化/.test(r.json.error || ''), JSON.stringify(r.json));
  source.rounds = 0;
  source.turns = [];
  plugin.state.reassignedTraces[tr.id] = savedMark;
  tr.reassignedTo = savedMark;

  const a2 = agent('session-reassign-2');
  await firePre(ctx, a2, '打印机驱动安装失败，打印队列一直卡住，需要重新安装驱动并清空 spool。', 2);
  await fireAssistant(ctx, a2, '先停 spooler，清空队列再重装驱动。');
  await sleep(50);
  await plugin.flush();
  snap = await plugin.snapshot();
  const tr2 = snap.trace.find(t => t.sessionId === 'session-reassign-2' && t.wsId && t.wsId !== targetId && Number(t.round) > 0);
  ok('第二个来源记录可定位', Boolean(tr2?.id), JSON.stringify(tr2));
  if (tr2) {
    r = await post({ op: 'reassign', traceId: tr2.id, into: targetId });
    ok('目标已有轮次时改派成功', r.status === 200 && r.json.ok === true, JSON.stringify(r.json));
    const tgt2 = plugin.state.workspaces.find(w => w.id === targetId);
    const added = (tgt2?.turns ?? []).filter(t => String(t.text).startsWith('打印机驱动') || String(t.text).startsWith('先停 spooler'));
    ok('目标已有轮次时不重置、不跳号', Number(tgt2?.rounds) === 2 && added.length === 2 && added.every(t => Number(t.turn) === 2), JSON.stringify({ rounds: tgt2?.rounds, added }));
  }

  await sleep(50);
  await plugin.flush();
  const saved = JSON.parse((await import('node:fs')).readFileSync(HOME_STATE(), 'utf8'));
  ok('改派结果已落盘', (saved.workspaces ?? []).some(w => w.id === sourceId) && (saved.workspaces ?? []).some(w => w.id === targetId), '');
  ok('改派标记已落盘', saved.reassignedTraces?.[tr.id]?.id === targetId, JSON.stringify(saved.reassignedTraces));

  // 重新 apply 一次模拟 DSH 重启：trace.jsonl 仍只有原始行，标记必须从 state 合并回来。
  const ctx2 = makeCtx({ webServer: false });
  const plugin2 = mod.apply(ctx2, { debug: false, disableProcessHook: true, sweepIntervalMs: 0 });
  const snap2 = await plugin2.snapshot();
  const trAfter = snap2.trace.find(t => t.id === tr.id);
  ok('重启后仍保留改派标记', trAfter?.reassignedTo?.id === targetId, JSON.stringify(trAfter));
  for (const h of ctx2.handlers.dispose ?? []) await h();
} finally {
  await new Promise(resolve => server.close(resolve));
  for (const h of ctx.handlers.dispose ?? []) await h();
}

function HOME_STATE () {
  return process.env.DSH_HOME + '/hybrid-workspace-v2/state.json';
}

console.log(fails ? 'REASSIGN FAIL ' + fails : 'REASSIGN PASS');
process.exit(fails ? 1 : 0);
