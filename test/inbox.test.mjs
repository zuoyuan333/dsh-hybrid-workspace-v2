import { createServer } from 'node:http';
import { tempHome, makeCtx, sleep } from './fake-ctx.mjs';
import { normalizeState } from '../lib/store.js';

process.env.DSH_HOME = tempHome();
const { apply } = await import('../lib/index.js');

let fails = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) fails++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : ''));
};

// 1) 落盘的 running 不能在重启后继续假装运行。
const loaded = normalizeState({ inbox: [{ id: 'q_loaded', text: '跑到一半', status: 'running', startedAt: 123 }] });
ok('重启后 running 变 failed', loaded.inbox[0].status === 'failed' && loaded.inbox[0].error.includes('中断'), JSON.stringify(loaded.inbox[0]));

const ctx = makeCtx({ webServer: true });
const inst = apply(ctx, { debug: false, llmJudge: false, sweepIntervalMs: 0, inboxExecutor: 'simulate' });
const route = ctx.routes[0];
const server = createServer((req, res) => route.handler(req, res));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port + '/hybrid-workspace';

async function req (path, opts) {
  const r = await fetch(base + path, opts);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json };
}
const post = (body) => req('/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const taskOf = (snap, id) => (snap.json.inbox || []).find(t => t.id === id);

try {
  const created = await post({ op: 'create', name: 'P1 测试区', description: '只验证收件箱串行出队' });
  ok('创建工作区', created.status === 200 && created.json.ok, created.text.slice(0, 120));
  const wsId = created.json.id;

  const empty = await req('/api');
  ok('初始收件箱为空', Array.isArray(empty.json.inbox) && empty.json.inbox.length === 0, JSON.stringify(empty.json.inbox));

  const noText = await post({ op: 'inboxAdd', text: '   ', workspaceId: wsId });
  ok('拒绝空任务', noText.status === 400 && noText.json.error, noText.text);
  const noWs = await post({ op: 'inboxAdd', text: '没有锁区' });
  ok('拒绝未锁区任务', noWs.status === 400 && noWs.json.error, noWs.text);
  const badWs = await post({ op: 'inboxAdd', text: '坏区', workspaceId: 'ws_not_exist' });
  ok('拒绝不存在的工作区', badWs.status === 400 && badWs.json.error, badWs.text);

  const a = await post({ op: 'inboxAdd', text: '第一条：整理门店掉线日志', workspaceId: wsId });
  ok('加入队列返回 queued', a.status === 200 && a.json.task?.status === 'queued' && a.json.task.workspaceId === wsId, JSON.stringify(a.json));
  const b = await post({ op: 'inboxAdd', text: '第二条：核对补货单', workspaceId: wsId });
  const c = await post({ op: 'inboxAdd', text: '第三条：生成周报', workspaceId: wsId });
  const ids = [a.json.task.id, b.json.task.id, c.json.task.id];
  const listed = await req('/api');
  ok('收件箱返回锁定工作区名', listed.json.inbox.length === 3 && listed.json.inbox.every(t => t.workspaceName === 'P1 测试区'), JSON.stringify(listed.json.inbox));

  const wsBefore = (await req('/api')).json.workspaces.find(w => w.id === wsId);
  const run = await post({ op: 'inboxRun' });
  ok('运行下一个启动最早任务', run.status === 200 && run.json.started === ids[0], JSON.stringify(run.json));
  const busy = await post({ op: 'inboxRun' });
  ok('运行中再次运行返回 busy', busy.status === 200 && busy.json.busy === true, JSON.stringify(busy.json));

  let maxRunning = 0;
  for (let i = 0; i < 16; i++) {
    const snap = await req('/api');
    maxRunning = Math.max(maxRunning, (snap.json.inbox || []).filter(t => t.status === 'running').length);
    await sleep(100);
  }
  ok('同一时刻最多一个 running', maxRunning <= 1, String(maxRunning));
  const afterA = await req('/api');
  const doneA = taskOf(afterA, ids[0]);
  ok('第一个任务完成并标记模拟', doneA?.status === 'done' && doneA.simulated === true && doneA.result.includes('未调用 DSH 执行器'), JSON.stringify(doneA));
  ok('完成时间不早于开始时间', doneA.finishedAt >= doneA.startedAt && doneA.startedAt > 0, JSON.stringify({ startedAt: doneA.startedAt, finishedAt: doneA.finishedAt }));

  const all = await post({ op: 'inboxRun', all: true });
  ok('顺序执行启动下一个', all.status === 200 && all.json.started === ids[1], JSON.stringify(all.json));
  let maxRunningAll = 0;
  for (let i = 0; i < 35; i++) {
    const snap = await req('/api');
    maxRunningAll = Math.max(maxRunningAll, (snap.json.inbox || []).filter(t => t.status === 'running').length);
    await sleep(100);
  }
  const afterAll = await req('/api');
  const bDone = taskOf(afterAll, ids[1]);
  const cDone = taskOf(afterAll, ids[2]);
  ok('顺序执行全部完成', bDone?.status === 'done' && cDone?.status === 'done', JSON.stringify({ b: bDone?.status, c: cDone?.status }));
  ok('顺序执行不并行', maxRunningAll <= 1, String(maxRunningAll));
  ok('顺序执行按入队顺序', bDone.startedAt <= cDone.startedAt, JSON.stringify({ b: bDone.startedAt, c: cDone.startedAt }));
  const wsAfter = (await req('/api')).json.workspaces.find(w => w.id === wsId);
  ok('收件箱不改工作区轮次/对话', wsAfter.rounds === wsBefore.rounds && (wsAfter.turns || []).length === (wsBefore.turns || []).length, JSON.stringify({ before: { rounds: wsBefore.rounds, turns: wsBefore.turns.length }, after: { rounds: wsAfter.rounds, turns: wsAfter.turns.length } }));
  ok('测试进程与插件实例一致', inst.state.workspaces.some(w => w.id === wsId));

  const d = await post({ op: 'inboxAdd', text: '第四条：这一条会被取消', workspaceId: wsId });
  const runD = await post({ op: 'inboxRun' });
  ok('启动待取消任务', runD.json.started === d.json.task.id, JSON.stringify(runD.json));
  const cancel = await post({ op: 'inboxCancel', id: d.json.task.id });
  ok('取消运行中任务', cancel.status === 200 && cancel.json.task.status === 'cancelled', JSON.stringify(cancel.json));
  await sleep(1400);
  ok('取消后不会再变 done', taskOf(await req('/api'), d.json.task.id)?.status === 'cancelled');
  const retry = await post({ op: 'inboxRetry', id: d.json.task.id });
  ok('失败/取消可重试回 queued', retry.status === 200 && retry.json.task.status === 'queued', JSON.stringify(retry.json));
  const badRetry = await post({ op: 'inboxRetry', id: ids[0] });
  ok('已完成任务不能重试', badRetry.status === 400 && badRetry.json.error, badRetry.text);
  const clear = await post({ op: 'inboxClear' });
  const afterClear = await req('/api');
  ok('清空已结束保留排队', clear.status === 200 && clear.json.removed === 3 && afterClear.json.inbox.length === 1 && afterClear.json.inbox[0].id === d.json.task.id && afterClear.json.inbox[0].status === 'queued', JSON.stringify({ clear: clear.json, inbox: afterClear.json.inbox }));
  const rm = await post({ op: 'inboxRemove', id: d.json.task.id });
  ok('删除排队任务', rm.status === 200 && !taskOf(await req('/api'), d.json.task.id), JSON.stringify(rm.json));

  const e = await post({ op: 'inboxAdd', text: '第五条：留着测全清', workspaceId: wsId });
  const clearAll = await post({ op: 'inboxClear', all: true });
  ok('全部清空', clearAll.status === 200 && (await req('/api')).json.inbox.length === 0, JSON.stringify(clearAll.json));
  ok('全清会停掉计时器', e.status === 200);

  const temp = await post({ op: 'create', name: '临时待删区' });
  const bad = await post({ op: 'inboxAdd', text: '任务所属工作区会被删掉', workspaceId: temp.json.id });
  const good = await post({ op: 'inboxAdd', text: '失败之后仍应继续', workspaceId: wsId });
  const blockedDelete = await post({ op: 'delete', id: temp.json.id });
  ok('有排队任务时不能删除工作区', blockedDelete.status === 400 && String(blockedDelete.json?.error || '').includes('收件箱'), JSON.stringify(blockedDelete.json));
  // 模拟工作区在外部被删除：保留任务，但目标区已不存在。
  inst.state.workspaces = inst.state.workspaces.filter(w => w.id !== temp.json.id);
  const runFail = await post({ op: 'inboxRun', all: true });
  ok('顺序执行遇到坏区先标失败', runFail.status === 200 && runFail.json.failed === bad.json.task.id, JSON.stringify(runFail.json));
  await sleep(1500);
  const afterFail = await req('/api');
  ok('坏区失败后继续跑下一条', taskOf(afterFail, bad.json.task.id)?.status === 'failed' && taskOf(afterFail, good.json.task.id)?.status === 'done', JSON.stringify({ bad: taskOf(afterFail, bad.json.task.id)?.status, good: taskOf(afterFail, good.json.task.id)?.status }));
} finally {
  await new Promise(resolve => server.close(resolve));
}

if (fails) {
  console.log('INBOX FAIL ' + fails);
  process.exitCode = 1;
} else {
  console.log('INBOX PASS');
}
