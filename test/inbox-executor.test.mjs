import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { tempHome, makeCtx, sleep } from './fake-ctx.mjs';

process.env.DSH_HOME = tempHome();
const { apply } = await import('../lib/index.js');

let fails = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) fails++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || !detail ? '' : '  [' + detail + ']'));
};

// fake agent：由测试显式触发 turn/start、assistant/message、turn/end。
// whenIdle 只在 complete/cancel 后 resolve，用来验证执行器真的在等子会话。
function makeChildFactory (store) {
  return async function create (options) {
    let seq = 0;
    const events = [];
    const injected = [];
    const followups = [];
    const idle = [];
    let completed = false;
    let cancelled = null;
    let disposed = false;
    let cancelEmitsTurn = true;
    const event = (type, data) => { events.push({ type, seq: ++seq, time: Date.now(), data }); };
    const wake = () => { completed = true; for (const resolve of idle.splice(0)) resolve(); };
    const agent = {
      session: {
        id: options.sessionId,
        header: { ...options.meta, meta: options.meta },
        requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
        snapshotEvents: () => events,
      },
      options: options.agentOptions,
      model: { current: () => options.agentOptions },
      inject: message => { injected.push(message); },
      followup: message => { followups.push(message); },
      whenIdle: () => completed ? Promise.resolve() : new Promise(resolve => idle.push(resolve)),
      cancel: cause => {
        if (cancelled) return;
        cancelled = cause;
        store.cancelled.push({ sessionId: options.sessionId, cause });
        if (!completed && cancelEmitsTurn) { event('turn/end', { turn: 1, reason: 'aborted' }); wake(); }
      },
    };
    const record = {
      agent, options, events, injected, followups, disposed: false,
      complete ({ text = '', reason = 'completed', error = null } = {}) {
        if (completed) return;
        event('turn/start', { turn: 1 });
        if (text) event('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text }] } });
        event('turn/end', { turn: 1, reason, ...(error ? { error } : {}) });
        wake();
      },
      get cancelled () { return cancelled; },
      get cancelEmitsTurn () { return cancelEmitsTurn; },
      set cancelEmitsTurn (value) { cancelEmitsTurn = Boolean(value); },
      setDisposed () { disposed = true; record.disposed = true; },
      get isDisposed () { return disposed; },
    };
    store.created.push(record);
    if (typeof options.setup === 'function') await options.setup({});
    return { agent, dispose: async () => record.setDisposed() };
  };
}

function makeServices (store) {
  const parents = [
    {
      session: { id: 'session-root-a', header: { cwd: '/tmp', agentPreset: 'default', delegationDepth: 0 }, requestHeader: () => ({ config: { provider: 'p', model: 'm' } }), snapshotEvents: () => [] },
      options: { provider: 'p', model: 'm' }, model: { current: () => ({ provider: 'p', model: 'm', reasoningEffort: 'high' }) },
    },
    {
      session: { id: 'parent-session-b', header: { cwd: '/tmp', agentPreset: 'default', delegationDepth: 0 }, requestHeader: () => ({ config: { provider: 'p', model: 'm' } }), snapshotEvents: () => [] },
      options: { provider: 'p', model: 'm' }, model: { current: () => ({ provider: 'p', model: 'm' }) },
    },
  ];
  const agents = {
    list: () => [...parents, ...store.created.map(r => r.agent)],
    get: id => [...parents, ...store.created.map(r => r.agent)].find(a => a.session.id === id) ?? null,
    create: makeChildFactory(store),
  };
  const services = {
    agents,
    approval: { setPolicy: (agent, policy) => store.policies.push({ sessionId: agent.session.id, policy }) },
    agentPresets: {
      resolve: async id => ({ id: id ?? 'default' }),
      mount: async (_agentCtx, id) => store.mounts.push(id),
    },
    sessionTitle: { rename: (session, title) => store.renames.push({ sessionId: session.id, title }) },
  };
  return services;
}

const store = { created: [], policies: [], mounts: [], renames: [], cancelled: [] };
const services = makeServices(store);
const ctx = makeCtx({ webServer: true });
ctx.get = name => services[name] ?? null;
const inst = apply(ctx, {
  debug: false, llmJudge: false, sweepIntervalMs: 0,
  inboxExecutor: 'auto', inboxMaxConcurrent: 2, inboxTaskTimeoutMs: 2000,
});
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
const post = body => req('/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const snap = async () => (await req('/api')).json;
const taskOf = (s, id) => (s.inbox || []).find(t => t.id === id);
const waitFor = async (fn, timeout = 4000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await fn()) return true;
    await sleep(25);
  }
  return false;
};
const byTask = text => store.created.find(r => r.followups.some(m => JSON.stringify(m.content).includes(text)));

try {
  const a = await post({ op: 'create', name: 'P2 区 A', description: '验证跨区并发' });
  const b = await post({ op: 'create', name: 'P2 区 B', description: '验证同区串行' });
  ok('创建两个试点区', a.json?.ok && b.json?.ok, a.text + b.text);
  const wsA = a.json.id;
  const wsB = b.json.id;
  inst.state.sessions['session-root-a'] = { workspaceId: wsA, routedAt: Date.now(), activeWorkspaceIds: [], recent: [] };
  inst.state.sessions['parent-session-b'] = { workspaceId: wsB, routedAt: Date.now(), activeWorkspaceIds: [], recent: [] };

  const a1 = (await post({ op: 'inboxAdd', text: 'A 第一条：检查插件入口', workspaceId: wsA })).json.task.id;
  const a2 = (await post({ op: 'inboxAdd', text: 'A 第二条：补回归测试', workspaceId: wsA })).json.task.id;
  const b1 = (await post({ op: 'inboxAdd', text: 'B 第一条：核对门店补货', workspaceId: wsB })).json.task.id;

  const before = await snap();
  ok('真实执行器可用', before.inboxConfig?.mode === 'dsh' && before.inboxConfig?.available === true, JSON.stringify(before.inboxConfig));
  ok('默认最多两并发', before.inboxConfig?.maxConcurrent === 2, JSON.stringify(before.inboxConfig));

  const run = await post({ op: 'inboxRun', all: true });
  ok('两个区各启动一个', run.json?.startedIds?.length === 2, JSON.stringify(run.json));
  ok('子会话已创建', await waitFor(() => store.created.length === 2), String(store.created.length));
  const childA = byTask('A 第一条');
  const childB = byTask('B 第一条');
  ok('A 用 A 区父会话', childA?.options.meta.parentSession === 'session-root-a', JSON.stringify(childA?.options.meta));
  ok('B 用 B 区父会话', childB?.options.meta.parentSession === 'parent-session-b', JSON.stringify(childB?.options.meta));
  ok('子会话标记为 subagent', store.created.every(r => r.options.meta.origin === 'subagent' && r.options.meta.delegationDepth === 1), JSON.stringify(store.created.map(r => r.options.meta)));
  ok('继承父会话模型', store.created.every(r => r.options.agentOptions.provider === 'p' && r.options.agentOptions.model === 'm'), JSON.stringify(store.created.map(r => r.options.agentOptions)));
  ok('审批策略设为 never', store.policies.length === 2 && store.policies.every(p => p.policy === 'never'), JSON.stringify(store.policies));
  ok('挂载父会话预设', store.mounts.length === 2 && store.mounts.every(id => id === 'default'), JSON.stringify(store.mounts));
  ok('第一条是插件边界，第二条是用户任务', childA?.injected[0]?.source?.kind === 'plugin:dsh-hybrid-workspace' && childA?.followups[0]?.source?.kind === 'user' && childA?.followups[0]?.content?.[0]?.text.includes('A 第一条'), JSON.stringify({ injected: childA?.injected?.[0]?.source, followup: childA?.followups?.[0]?.source }));
  ok('任务卡带子会话 id', (await snap()).inbox.filter(t => t.status === 'running').every(t => t.executor === 'dsh' && t.childSessionId.startsWith('session-')), JSON.stringify((await snap()).inbox));

  childA.complete({ text: 'A 第一条完成' });
  const a1Done = await waitFor(async () => taskOf(await snap(), a1)?.status === 'done');
  ok('A 第一条完成并回写', a1Done, JSON.stringify(taskOf(await snap(), a1)));
  const a1Task = taskOf(await snap(), a1);
  ok('完成结果不是模拟', a1Task?.simulated === false && a1Task?.result === 'A 第一条完成', JSON.stringify(a1Task));
  ok('完成后释放子会话', childA?.isDisposed === true, String(childA?.isDisposed));
  ok('同区第二条等第一条结束才启动', await waitFor(() => store.created.length === 3), String(store.created.length));
  const childA2 = byTask('A 第二条');
  ok('A 第二条父会话仍为 A', childA2?.options.meta.parentSession === 'session-root-a', JSON.stringify(childA2?.options.meta));
  ok('B 仍在运行，未串行化到全局', taskOf(await snap(), b1)?.status === 'running', JSON.stringify(taskOf(await snap(), b1)));

  childB.complete({ text: 'B 第一条完成' });
  childA2.complete({ text: 'A 第二条完成' });
  ok('三个任务全部完成', await waitFor(async () => {
    const s = await snap();
    return [a1, a2, b1].every(id => taskOf(s, id)?.status === 'done');
  }), JSON.stringify((await snap()).inbox.map(t => [t.id, t.status])));
  ok('结果分别回写', taskOf(await snap(), a2)?.result === 'A 第二条完成' && taskOf(await snap(), b1)?.result === 'B 第一条完成');

  const a3 = (await post({ op: 'inboxAdd', text: 'A 第三条：故意失败', workspaceId: wsA })).json.task.id;
  await post({ op: 'inboxRun', all: true });
  ok('失败任务子会话已起', await waitFor(() => Boolean(byTask('A 第三条'))), String(store.created.length));
  byTask('A 第三条').complete({ reason: 'error', error: { message: 'boom' } });
  ok('turn/end error 变 failed', await waitFor(async () => taskOf(await snap(), a3)?.status === 'failed'), JSON.stringify(taskOf(await snap(), a3)));
  const failedTask = taskOf(await snap(), a3);
  ok('失败带原因且不伪造完成', failedTask?.error.includes('boom') && failedTask?.result === '' && failedTask?.simulated === false, JSON.stringify(failedTask));

  services.agents = null;
  const a4 = (await post({ op: 'inboxAdd', text: 'A 第四条：服务缺失', workspaceId: wsA })).json.task.id;
  const off = await snap();
  ok('服务缺失时 UI 能看到不可用', off.inboxConfig?.available === false && Boolean(off.inboxConfig?.reason), JSON.stringify(off.inboxConfig));
  await post({ op: 'inboxRun', all: true });
  ok('服务缺失任务明确失败', await waitFor(async () => taskOf(await snap(), a4)?.status === 'failed'), JSON.stringify(taskOf(await snap(), a4)));
  ok('失败信息指向 agents', taskOf(await snap(), a4)?.error.includes('agents'), JSON.stringify(taskOf(await snap(), a4)));
  services.agents = makeServices(store).agents;

  const a5 = (await post({ op: 'inboxAdd', text: 'A 第五条：等待取消', workspaceId: wsA })).json.task.id;
  await post({ op: 'inboxRun', all: true });
  ok('取消测试子会话已起', await waitFor(() => Boolean(byTask('A 第五条'))), String(store.created.length));
  const childA5 = byTask('A 第五条');
  const cancel = await post({ op: 'inboxCancel', id: a5 });
  ok('取消立即生效', cancel.json?.task?.status === 'cancelled', JSON.stringify(cancel.json));
  ok('取消会中断子会话', await waitFor(() => childA5?.cancelled === 'user'), String(childA5?.cancelled));
  childA5.complete({ text: '取消后仍返回完成' });
  await sleep(150);
  ok('取消后不覆盖为 done', taskOf(await snap(), a5)?.status === 'cancelled', JSON.stringify(taskOf(await snap(), a5)));

  const a5b = (await post({ op: 'inboxAdd', text: 'A 第五条之二：turn 前取消', workspaceId: wsA })).json.task.id;
  await post({ op: 'inboxRun', all: true });
  ok('turn 前取消测试子会话已起', await waitFor(() => Boolean(byTask('A 第五条之二'))), String(store.created.length));
  const childA5b = byTask('A 第五条之二');
  childA5b.cancelEmitsTurn = false;
  const cancelBeforeTurn = await post({ op: 'inboxCancel', id: a5b });
  ok('turn 前取消立即生效', cancelBeforeTurn.json?.task?.status === 'cancelled', JSON.stringify(cancelBeforeTurn.json));
  ok('turn 前取消立即释放并发锁', await waitFor(async () => (await snap()).inboxConfig?.active === 0, 1000), JSON.stringify((await snap()).inboxConfig));
  ok('turn 前取消释放子会话', await waitFor(() => childA5b?.isDisposed === true, 1000), String(childA5b?.isDisposed));

  const a6 = (await post({ op: 'inboxAdd', text: 'A 第六条：超时', workspaceId: wsA })).json.task.id;
  await post({ op: 'inboxRun', all: true });
  ok('超时测试子会话已起', await waitFor(() => Boolean(byTask('A 第六条'))), String(store.created.length));
  ok('超时后 failed', await waitFor(async () => taskOf(await snap(), a6)?.status === 'failed', 5000), JSON.stringify(taskOf(await snap(), a6)));
  ok('超时会主动取消', byTask('A 第六条')?.cancelled === 'user', String(byTask('A 第六条')?.cancelled));
  ok('超时信息可读', taskOf(await snap(), a6)?.error.includes('超时'), JSON.stringify(taskOf(await snap(), a6)));

  const a7 = (await post({ op: 'inboxAdd', text: 'A 第七条：清空时中断', workspaceId: wsA })).json.task.id;
  await post({ op: 'inboxRun', all: true });
  ok('清空测试子会话已起', await waitFor(() => Boolean(byTask('A 第七条'))), String(store.created.length));
  const beforeClear = (await snap()).inbox.length;
  const clear = await post({ op: 'inboxClear', all: true });
  ok('全部清空立即移除任务', clear.json?.ok === true && (await snap()).inbox.length === 0, JSON.stringify({ beforeClear, clear: clear.json }));
  ok('清空会中断在跑子会话', await waitFor(() => byTask('A 第七条')?.cancelled === 'user'), String(byTask('A 第七条')?.cancelled));
} finally {
  await new Promise(resolve => server.close(resolve));
  await inst.flush().catch(() => {});
}
console.log(fails ? 'INBOX-EXECUTOR FAIL ' + fails : 'INBOX-EXECUTOR PASS');
process.exit(fails ? 1 : 0);
