import { createServer } from 'node:http';
import { tempHome, makeCtx, sleep } from './fake-ctx.mjs';
import { report, workspaceFacts, DAY } from '../lib/governance.js';
import { createWorkspace } from '../lib/router.js';

let fails = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) fails++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : ''));
};

const now = Date.now();
const old = now - 10 * DAY;
const mk = (id, name, extra = {}) => ({
  id, name, rounds: 0, turns: [], memories: [], createdAt: old, updatedAt: old, ...extra,
});

// 1) 报告只给诊断：auto 只含空壳/长期不活跃，重复与超限只进 review。
const sessions = {
  s1: { workspaceId: 'dup-a', routedAt: now - 1000, recent: [] },
  s2: { workspaceId: 'dup-b', routedAt: now - 2000, recent: [] },
};
const dupA = mk('dup-a', '门店 A', { rounds: 5, updatedAt: now - 1000 });
const dupB = mk('dup-b', '门店A', { rounds: 1, updatedAt: now - 2000 });
const empty = mk('empty');
const stale = mk('stale', '旧项目', { rounds: 3, turns: [{ role: 'user', text: '旧对话' }], createdAt: now - 40 * DAY, updatedAt: now - 31 * DAY });
const low = mk('low', '低活跃', { rounds: 1, turns: [{ role: 'user', text: '只有一轮' }], updatedAt: now - 2 * DAY });
const r = report({
  workspaces: [empty, stale, low, dupA, dupB],
  sessions,
  cfg: { activeLimit: 12, governanceEmptyTtlMs: 7 * DAY, governanceStaleMs: 30 * DAY },
  now,
});
ok('空壳满 7 天标记为可归档', r.auto.some(x => x.id === 'empty' && x.reason === 'empty-shell'), JSON.stringify(r.auto.map(x => [x.id, x.reason])));
ok('无会话且有内容满 30 天标记为可归档', r.auto.some(x => x.id === 'stale' && x.reason === 'stale'), JSON.stringify(r.auto.map(x => [x.id, x.reason])));
ok('低活跃只给建议不自动归档', r.review.some(x => x.id === 'low' && x.reason === 'low-activity') && !r.auto.some(x => x.id === 'low'), JSON.stringify(r.review.map(x => [x.id, x.reason])));
ok('同名工作区只给合并建议', r.duplicates.length === 1 && r.duplicates[0].id === 'dup-b' && r.duplicates[0].suggestedInto.id === 'dup-a', JSON.stringify(r.duplicates[0]));
ok('活跃会话计入 facts', workspaceFacts(dupA, sessions, now).sessions === 1 && workspaceFacts(dupA, sessions, now).lastActiveAt === now - 1000, JSON.stringify(workspaceFacts(dupA, sessions, now)));

const many = [
  mk('m1', '甲', { updatedAt: now - 30 * DAY }),
  mk('m2', '乙', { updatedAt: now - 2 * DAY }),
  mk('m3', '丙', { updatedAt: now - 1 * DAY }),
];
const r2 = report({ workspaces: many, sessions: { a: { workspaceId: 'm1', routedAt: now - 30 * DAY }, b: { workspaceId: 'm2', routedAt: now - 2 * DAY }, c: { workspaceId: 'm3', routedAt: now - 1 * DAY } }, cfg: { activeLimit: 2 }, now });
ok('超出上限只建议最久未用', r2.overLimit.length === 1 && r2.overLimit[0].id === 'm1' && r2.review.some(x => x.id === 'm1' && x.reason === 'over-limit'), JSON.stringify(r2.overLimit.map(x => x.id)));

// 2) 插件扫描只给建议：空壳不被自动归档，但出现在 candidates 中。
process.env.DSH_HOME = tempHome();
const { apply } = await import('../lib/index.js');
const ctx = makeCtx({ webServer: false });
const plugin = apply(ctx, {
  debug: false, disableProcessHook: true, sweepIntervalMs: 0,
  governanceEmptyTtlMs: 7 * DAY, governanceStaleMs: 30 * DAY,
});
await plugin.snapshot();
const oldShell = createWorkspace('旧空壳');
oldShell.createdAt = oldShell.updatedAt = now - 10 * DAY;
plugin.state.workspaces.push(oldShell);
const snap = await plugin.snapshot();
ok('治理不再自动归档空壳', snap.workspaces.some(w => w.id === oldShell.id), JSON.stringify(snap.workspaces.map(w => w.name)));
ok('空壳仍进入治理建议', snap.governance && snap.governance.candidates.some(x => x.id === oldShell.id && x.reason === 'empty-shell'), JSON.stringify(snap.governance?.candidates?.map(x => [x.id, x.reason])));
ok('没有生成治理归档记录', !snap.archives.some(a => a.id === oldShell.id), JSON.stringify(snap.archives.map(a => [a.id, a.reason])));
ok('快照暴露治理报告', snap.governance && typeof snap.governance.total === 'number' && Array.isArray(snap.governance.candidates), JSON.stringify(snap.governance?.counts));

// 3) 手动批量归档 + /shell 页面。
process.env.DSH_HOME = tempHome();
const ctx2 = makeCtx({ webServer: true });
const plugin2 = apply(ctx2, { debug: false, disableProcessHook: true, sweepIntervalMs: 0 });
await plugin2.snapshot();
const manual = createWorkspace('手动治理区');
manual.createdAt = manual.updatedAt = now - 2 * DAY;
plugin2.state.workspaces.push(manual);
const route = ctx2.routes[0];
const server = createServer((req, res) => route.handler(req, res));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port + '/hybrid-workspace';
try {
  const got = await fetch(base + '/api').then(r => r.json());
  ok('API 返回治理报告', got.governance && got.governance.total === 1, JSON.stringify(got.governance?.total));
  const archived = await fetch(base + '/api', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'governanceApply', ids: [manual.id, 'missing'] }),
  }).then(r => r.json());
  ok('手动治理归档返回结果', Array.isArray(archived.archived) && archived.archived.some(x => x.id === manual.id) && archived.skipped.some(x => x.id === 'missing'), JSON.stringify(archived));
  const after = await fetch(base + '/api').then(r => r.json());
  ok('手动归档后工作区消失且归档保留', !after.workspaces.some(w => w.id === manual.id) && after.archives.some(a => a.id === manual.id && a.reason === 'governance'), JSON.stringify(after.archives.map(a => a.reason)));
  const shell = await fetch(base + '/shell/');
  const shellText = await shell.text();
  ok('/shell 返回面板页', shell.status === 200 && shellText.includes('const SHELL') && shellText.includes('id="chat"'), String(shell.status));
  const shellApi = await fetch(base + '/api').then(r => r.json());
  ok('/shell 仍使用同一 API', Array.isArray(shellApi.workspaces), JSON.stringify(shellApi.workspaces?.length));
} finally {
  await new Promise(resolve => server.close(resolve));
}


console.log(fails ? 'GOVERNANCE FAIL ' + fails : 'GOVERNANCE PASS');
process.exit(fails ? 1 : 0);
