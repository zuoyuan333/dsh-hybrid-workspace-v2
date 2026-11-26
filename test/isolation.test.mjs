import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCtx, userMsg } from './fake-ctx.mjs';

const HOME = mkdtempSync(join(tmpdir(), 'hw-isolation-'));
process.env.DSH_HOME = HOME;
// waitForTurn 的轮询定时器是 unref 的；测试进程需要自己保活，模拟常驻的 DSH 宿主。
const keepAlive = setInterval(() => {}, 1000);

const { apply } = await import('../lib/index.js');
const { SessionIsolation } = await import('../lib/isolation.js');

let failures = 0;
const check = (label, cond, detail = '') => {
  if (!cond) failures++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (detail ? '  [' + detail + ']' : ''));
};

function childFactory (store) {
  return async function create (options) {
    let completed = false;
    let cancelled = null;
    let disposed = false;
    let turn = 0;
    let nextReason = 'completed';
    const events = [];
    const injected = [];
    const followups = [];
    const idle = [];
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
      followup: message => {
        followups.push(message);
        completed = false;
        setTimeout(() => {
          turn++;
          events.push({ type: 'turn/start', seq: events.length + 1, data: { turn } });
          events.push({ type: 'assistant/message', seq: events.length + 1, data: { turn, step: 1, message: { content: [{ type: 'text', text: '子会话回答 ' + turn }] } } });
          events.push({
            type: 'turn/end', seq: events.length + 1,
            data: { turn, reason: nextReason === 'error' ? { kind: 'error', error: { message: 'boom' } } : { kind: 'completed' } },
          });
          completed = true;
          for (const resolve of idle.splice(0)) resolve();
        }, 0);
      },
      whenIdle: () => completed ? Promise.resolve() : new Promise(resolve => idle.push(resolve)),
      cancel: cause => {
        if (cancelled) return;
        cancelled = cause;
        completed = true;
        for (const resolve of idle.splice(0)) resolve();
      },
    };
    const record = {
      agent, options, events, injected, followups,
      get cancelled () { return cancelled; },
      get disposed () { return disposed; },
      set nextReason (value) { nextReason = value; },
      dispose: async () => { disposed = true; },
    };
    store.created.push(record);
    if (typeof options.setup === 'function') await options.setup({});
    return { agent, dispose: record.dispose };
  };
}

function makeServices (store) {
  const ctx = makeCtx();
  ctx.agents = { list: () => [], get: () => null, create: childFactory(store) };
  ctx.approval = { setPolicy: (agent, value) => store.policies.push({ sessionId: agent.session.id, value }) };
  ctx.agentPresets = { resolve: async id => ({ id: id ?? 'default' }), mount: async (_ctx, id) => store.mounts.push(id) };
  ctx.sessionTitle = { rename: (session, title) => store.renames.push({ sessionId: session.id, title }) };
  ctx.get = name => ({ agents: ctx.agents, approval: ctx.approval, agentPresets: ctx.agentPresets, sessionTitle: ctx.sessionTitle }[name] ?? null);
  return ctx;
}

const store = { created: [], policies: [], mounts: [], renames: [] };
const ctx = makeServices(store);
const plugin = apply(ctx, {
  debug: false,
  disableProcessHook: true,
  mode: 'lexical',
  isolationPilot: ['*'],
  isolationTimeoutMs: 3000,
});
const append = [];
const parent = {
  session: {
    id: 'session-parent',
    header: { cwd: '/tmp', agentPreset: 'default', delegationDepth: 0 },
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
    append: (type, data, opts) => append.push({ type, data, opts }),
  },
  options: { provider: 'p', model: 'm' },
  model: { current: () => ({ provider: 'p', model: 'm' }) },
};

async function fire (text, turn) {
  let decision = null;
  for (const handler of ctx.handlers['agent/pre-step'] ?? []) {
    decision = await handler({ agent: parent, messages: [userMsg(text)], turn, step: 1 }, async () => ({
      kind: 'enter', messages: [userMsg(text)],
    }));
  }
  return decision;
}

// 策略门禁：只有试点区 + isolation=session 才启用。
const gate = new SessionIsolation({ ctx: {}, cfg: { isolationPilot: ['ws_x'] }, log: () => {} });
check('试点区默认提示词隔离', gate.isPilot({ id: 'ws_x' }) && !gate.enabledFor({ id: 'ws_x', policy: {} }));
check('非试点区即使选 session 也不启用', !gate.enabledFor({ id: 'ws_y', policy: { isolation: 'session' } }));
check('试点区显式 session 才启用', gate.enabledFor({ id: 'ws_x', policy: { isolation: 'session' } }));
check('通配试点区', new SessionIsolation({ ctx: {}, cfg: { isolationPilot: '*' }, log: () => {} }).isPilot({ id: 'ws_any' }));

// 没有 agents 时明确回退到提示词隔离，不抛到 DSH。
const fallback = await gate.takeOver({
  parent, ws: { id: 'ws_x', name: '隔离区' }, messages: [userMsg('回退测试')], text: '回退测试', turn: 1, step: 1,
});
check('服务缺失时 takeOver 返回 null（回退提示词）', fallback === null, String(fallback));

// 第一条消息只做路由；手动把区策略切到 session 后，第二条进入子会话接管。
const first = await fire('隔离试点：收银终端昨晚掉线，先看断线日志', 1);
const sid = parent.session.id;
const wsId = plugin.state.sessions[sid]?.workspaceId;
const ws = plugin.state.workspaces.find(w => w.id === wsId);
check('第一条走普通路由', first?.kind === 'enter' && first.messages.length === 1, JSON.stringify(first));
check('试点区已标记', ws?.id != null && (await plugin.snapshot()).workspaces.find(w => w.id === ws.id)?.isolationPilot === true, String(wsId));
if (ws) ws.policy = { ...(ws.policy ?? {}), isolation: 'session' };

const second = await fire('还是掉线，继续看同一台终端的日志', 2);
check('第二条进入隔离子会话且父模型不调用', second?.kind === 'enter' && Array.isArray(second.messages) && second.messages.length === 0, JSON.stringify(second));
check('只创建一个子会话', store.created.length === 1, String(store.created.length));
const child = store.created[0];
check('子会话 origin=subagent 且带父会话', child?.options?.meta?.origin === 'subagent' && child.options.meta.parentSession === sid);
check('子会话审批固定 never', store.policies.some(p => p.sessionId === child?.agent?.session?.id && p.value === 'never'));
check('子会话只注入本区资料', child?.injected?.length === 1 && child.injected[0].content[0].text.includes(ws?.name ?? '') && child.injected[0].content[0].text.includes('只依据下面的工作区资料回答'));
check('父会话按顺序记录 step/user/assistant/step', append.map(x => x.type).join(',') === 'step/start,user/message,assistant/message,step/end', append.map(x => x.type).join(','));
check('父会话展示子会话答案', append.find(x => x.type === 'assistant/message')?.data?.message?.content?.[0]?.text === '子会话回答 1');
check('父会话用户消息带 surfaceOp', append.find(x => x.type === 'user/message')?.opts?.surfaceOp === 'append');
check('父会话助手消息带 surfaceOp', append.find(x => x.type === 'assistant/message')?.opts?.surfaceOp === 'append');
check('子会话收到原用户消息', child?.followups?.length === 1 && child.followups[0].content?.[0]?.text.includes('还是掉线'));
check('isChild 能识别子会话', gate.isChild('ws_none') === false && (await (async () => {
  const live = new SessionIsolation({ ctx, cfg: { isolationPilot: ['*'] }, log: () => {} });
  await live.ensure(parent, ws, '识别测试');
  const id = live.children.get(ws.id)?.childSessionId;
  const hit = live.isChild(id);
  await live.disposeAll();
  return hit;
})()));

// 第二个回合复用同一子会话，不重复创建。
const third = await fire('再确认一下重连记录', 3);
check('后续回合复用子会话', third?.kind === 'enter' && third.messages.length === 0 && store.created.length === 2, 'created=' + store.created.length);
check('复用后子会话收到第二条', store.created[0]?.followups?.length === 2, String(store.created[0]?.followups?.length));

// 子会话失败时写明确错误并销毁，下一轮重建；不能悄悄交给父模型。
store.created[0].nextReason = 'error';
const failed = await fire('这次故意让子会话失败', 4);
check('子会话失败仍返回空 messages（父模型不回答）', failed?.kind === 'enter' && failed.messages.length === 0, JSON.stringify(failed));
const lastAssistant = append.filter(x => x.type === 'assistant/message').at(-1);
check('失败答案写入父会话', String(lastAssistant?.data?.message?.content?.[0]?.text ?? '').includes('隔离子会话结束原因'), JSON.stringify(lastAssistant));
check('失败后销毁子会话', store.created[0]?.disposed === true && (await plugin.snapshot()).workspaces.find(w => w.id === ws.id)?.isolationActive === false);

const recovered = await fire('失败后重新开始', 5);
check('失败后下一轮重建子会话', recovered?.kind === 'enter' && recovered.messages.length === 0 && store.created.length === 3, 'created=' + store.created.length);
check('重建子会话收到消息', store.created[2]?.followups?.length === 1, String(store.created[2]?.followups?.length));

for (const handler of ctx.handlers.dispose ?? []) await handler();
check('dispose 释放子会话', store.created.every(c => c.disposed), store.created.map(c => c.disposed).join(','));
check('保存后 active=0', (await plugin.snapshot()).workspaces.find(w => w.id === ws.id)?.isolationActive === false);

clearInterval(keepAlive);
console.log(failures === 0 ? '\nISOLATION PASS' : '\n' + failures + ' FAILED');
process.exit(failures === 0 ? 0 : 1);
