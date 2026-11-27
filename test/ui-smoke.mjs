import { createServer } from 'node:http';
import { tempHome, makeCtx, agent, firePre, fireAssistant, sleep } from './fake-ctx.mjs';

process.env.DSH_HOME = tempHome();
const { apply } = await import('../lib/index.js');

let fails = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) fails++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : ''));
};

const ctx = makeCtx({ webServer: true });
const inst = apply(ctx, { debug: false, llmJudge: false, sweepIntervalMs: 0 });
const a = agent('s1');
await firePre(ctx, a, '示范门店收银机每天下午四点断线，先查 net.log 的 reconnect 记录', 1, 1);
await fireAssistant(ctx, a, '结论：示范门店收银机断线是 4G 链路心跳超时导致，下一步要把 reconnect 间隔改成 30 秒。');
await firePre(ctx, a, '示范门店收银机断线排查，以后每次回答都用简体中文，先给结论', 2, 1);
await sleep(80);
ok('面板路由已注册', ctx.routes.length === 1, String(ctx.routes.length));

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

try {
  const page = await req('');
  ok('面板 200', page.status === 200, String(page.status));
  ok('页面标题 v2.8.3', page.text.includes('混合工作区') && page.text.includes('v2.8.3'));
  ok('页面含记忆区块', page.text.includes('相关记忆') && page.text.includes('代表性问法'));
  ok('页面含路由 trace', page.text.includes('最近路由判定'));
  ok('页面 trace 含一键改派', page.text.includes('data-reassign-to=') && page.text.includes('data-reassign=') && page.text.includes('纠正'));
  ok('页面含合并按钮', page.text.includes('data-op="merge"'));
  ok('页面含归档/删除按钮', page.text.includes('data-op="archive"') && page.text.includes('data-op="delete"'));
  ok('页面不再含原生壳入口', !page.text.includes('id="open-shell"') && !page.text.includes('op: \'openShell\''));
  ok('页面不再含工作区聊天壳', !page.text.includes('id="chat"') && !page.text.includes('const SHELL') && !page.text.includes('function initShell'));
  ok('页面含保存失败横幅', page.text.includes('id="save-warning"') && page.text.includes('function renderSaveWarning') && page.text.includes('状态保存失败'));
  ok('管理面板保留统一收件箱', page.text.includes('id="inbox"') && page.text.includes("op: 'inboxAdd'") && page.text.includes("op: 'inboxRun'"));
  const shellRedirect = await fetch(base + '/shell', { redirect: 'manual' });
  ok('旧聊天页地址重定向到管理面板', shellRedirect.status === 302 && String(shellRedirect.headers.get('location') || '').endsWith('/hybrid-workspace/'), shellRedirect.status + ' ' + shellRedirect.headers.get('location'));
  const shellPage = await req('/shell');
  ok('重定向后的页面是管理面板', shellPage.status === 200 && shellPage.text.includes('id="inbox"') && !shellPage.text.includes('const SHELL'), String(shellPage.status));
  ok('页面含治理区', page.text.includes('id="governance"') && page.text.includes('工作区治理') && page.text.includes('data-gov="archive-picked"'));
  ok('页面含关闭面板按钮', page.text.includes('id="close-panel"'));
  ok('嵌入 iframe 时隐藏面板关闭', page.text.includes('window.self !== window.top') && page.text.includes('.embedded #close-panel') && !page.text.includes('.embedded #open-shell'));
  ok('关闭面板只关独立小窗，同窗回 DSH 首页', page.text.includes("const popup = window.name === 'hybrid-workspace-panel'") && page.text.includes('if (popup)') && page.text.includes("window.location.assign('/')"));
  ok('页面使用内嵌对话框而不是浏览器 prompt/confirm/alert', page.text.includes('function openDialog') && !/\b(prompt|confirm|alert)\s*\(/.test(page.text));
  ok('页面含上下文占用', page.text.includes('上下文占用') && page.text.includes('所有区合计'));
  ok('页面含统一收件箱', page.text.includes('id="inbox"') && page.text.includes('统一收件箱') && page.text.includes('实验'));
  ok('收件箱说明真实执行器与审批隔离', page.text.includes('独立 DSH 子会话') && page.text.includes('审批固定为 never') && page.text.includes('不会伪造完成'));
  ok('收件箱接入 API', page.text.includes("op: 'inboxAdd'") && page.text.includes("op: 'inboxRun'") && page.text.includes("op: 'inboxClear'"));
  ok('页面含上下文构成', page.text.includes('上下文构成') && page.text.includes('工作区卡') && page.text.includes('相关记忆'));
  ok('页面含多话题统计', page.text.includes('多话题'));
  ok('页面含全局档案/置顶/恢复', page.text.includes('全局档案') && page.text.includes('data-mem="pin"') && page.text.includes('data-mem="restore"'));
  ok('页面含导出/导入', page.text.includes('id="export"') && page.text.includes('id="import"'));
  ok('页面含策略与结论演变', page.text.includes('data-op="policy"') && page.text.includes('结论演变'));
  ok('策略按钮在卡片标题行', /class="topic-actions">[^\n]*data-op="policy"/.test(page.text));
  ok('页面含试点会话隔离策略', page.text.includes('id="pol-iso"') && page.text.includes('独立子会话（实验）'));
  ok('页面含隔离状态文案', page.text.includes('isolationPilot') && page.text.includes('仅提示词'));
  ok('页面 trace 含命中词', page.text.includes('命中词') && page.text.includes('问句词'));
  ok('页面自包含无外链', !page.text.includes('https://') && !page.text.includes('http://'));
  ok('面板复选框不被全局 min-width 撑宽', page.text.includes('input[type="checkbox"], input[type="radio"] { min-width:0;'));
ok('页面体积正常', page.text.length > 7000, String(page.text.length));

  const api = await req('/api');
  ok('API 200 JSON', api.status === 200 && api.json && Array.isArray(api.json.workspaces), String(api.status));
  ok('API 返回保存错误状态', api.json.saveError === null, JSON.stringify(api.json.saveError));
  const ws = api.json.workspaces[0];
  ok('API 返回工作区', api.json.workspaces.length === 1 && ws.name.includes('示范门店'), ws?.name);
  ok('API 返回结构化记忆', (ws.memories ?? []).length >= 1 && ws.memoryStats, JSON.stringify(ws.memoryStats));
  ok('API 返回会话绑定', (api.json.sessions ?? []).length === 1);
  ok('API 返回上下文占用', (ws.contextChars ?? 0) > 0 && (ws.contextTokens ?? 0) > 0 && (ws.contextPct ?? 0) > 0, JSON.stringify({ chars: ws.contextChars, tokens: ws.contextTokens, pct: ws.contextPct }));
  ok('API 统计含上下文合计', api.json.stats.contextChars >= ws.contextChars && api.json.stats.contextTokens >= ws.contextTokens);
  ok('API 统计含上下文构成', (api.json.stats.contextBreakdown?.total ?? 0) > 0 && (api.json.stats.contextBreakdown?.memories ?? 0) >= 0, JSON.stringify(api.json.stats.contextBreakdown));
  ok('API 统计含多话题计数', Number.isFinite(api.json.stats.multiTurns), String(api.json.stats.multiTurns));
  ok('无 cost-meter 时费用隐藏', api.json.cost?.available === false, JSON.stringify(api.json.cost));
  ok('API 返回全局档案', Array.isArray(api.json.profile) && api.json.profile.length >= 1 && api.json.profile[0].tier === 'profile', JSON.stringify(api.json.profile?.[0] || null));
  ok('API 统计含全局档案/过期', (api.json.stats.profile ?? 0) >= 1 && Number.isFinite(api.json.stats.expired), JSON.stringify({ profile: api.json.stats.profile, expired: api.json.stats.expired }));
  ok('API 会话含活跃区字段', Array.isArray(api.json.sessions[0]?.activeWorkspaceIds), JSON.stringify(api.json.sessions[0]));

  const pm = api.json.profile[0];
  const unpin = await req('/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'pin', id: pm.id, pinned: false }) });
  ok('取消置顶返回 ok', unpin.status === 200 && unpin.json?.ok && unpin.json.memory?.pinned === false, JSON.stringify(unpin.json));
  const afterUnpin = await req('/api');
  ok('取消置顶已生效', afterUnpin.json.profile[0].pinned === false);
  const repin = await req('/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'pin', id: pm.id, pinned: true }) });
  ok('重新置顶返回 ok', repin.status === 200 && repin.json?.ok && repin.json.memory?.pinned === true, JSON.stringify(repin.json));

  const live = inst.state.workspaces[0];
  live.memories.push({
    id: 'm_ui_expired', type: 'fact', text: '旧结论：这条应该被懒清扫', keys: ['旧结论'], importance: 2,
    turn: 1, at: Date.now() - 1000, status: 'active', source: 'test', tier: 'durable', scope: 'workspace',
    pinned: false, validUntil: Date.now() - 1, expiresAt: Date.now() - 1, ttlMs: 0,
  });
  const readOnly = await req('/api');
  const ro = (readOnly.json.workspaces[0].memories || []).find(m => m.id === 'm_ui_expired');
  ok('GET 不触发懒清扫', ro?.status === 'active', JSON.stringify({ status: ro?.status }));
  const swept = await req('/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'sweep' }) });
  const afterSweep = await req('/api');
  const ex = (afterSweep.json.workspaces[0].memories || []).find(m => m.id === 'm_ui_expired');
  ok('显式 sweep 标记过期', ex?.status === 'expired' && (afterSweep.json.stats.expired ?? 0) >= 1, JSON.stringify({ status: ex?.status, expired: afterSweep.json.stats.expired, sweep: swept.json }));
  const restoredMem = await req('/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'restoreMemory', id: 'm_ui_expired' }) });
  ok('恢复记忆返回 ok', restoredMem.status === 200 && restoredMem.json?.ok && restoredMem.json.memory?.status === 'active', JSON.stringify(restoredMem.json));

  const renamed = await req('/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'rename', id: ws.id, name: '示范门店终端掉线' }) });
  ok('重命名返回 ok', renamed.status === 200 && renamed.json?.ok, String(renamed.status) + ' ' + renamed.text.slice(0, 80));
  const afterRename = await req('/api');
  ok('重命名已生效', afterRename.json.workspaces[0].name === '示范门店终端掉线', afterRename.json.workspaces[0].name);

  const described = await req('/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'describe', id: ws.id, description: '收银终端 4G 链路与 net.log 排查' }) });
  ok('改范围返回 ok', described.status === 200 && described.json?.ok);
  const afterDescribe = await req('/api');
  ok('改范围已生效', afterDescribe.json.workspaces[0].description.includes('4G'));

  const archived = await req('/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'archive', id: ws.id }) });
  ok('归档返回 ok 与释放量', archived.status === 200 && archived.json?.ok && archived.json.archived && archived.json.freed?.chars > 0, JSON.stringify(archived.json));
  const afterArchive = await req('/api');
  ok('归档后工作区为空', afterArchive.json.workspaces.length === 0);
  ok('归档保留快照与占用', afterArchive.json.archives.length === 1 && afterArchive.json.archives[0].contextChars > 0 && (afterArchive.json.archives[0].turns ?? []).length >= 1);
  ok('归档解绑会话', (afterArchive.json.sessions[0]?.workspaceId ?? null) === null);
  const archiveId = afterArchive.json.archives[0]?.id;
  const restored = await req('/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'restore', id: archiveId }) });
  ok('恢复返回新 id', restored.status === 200 && restored.json?.ok && restored.json.id, JSON.stringify(restored.json));
  const afterRestore = await req('/api');
  ok('恢复后回到列表', afterRestore.json.workspaces.length === 1 && afterRestore.json.archives.length === 0);
  ok('恢复保留轮数/记忆', afterRestore.json.workspaces[0].rounds >= 1 && (afterRestore.json.workspaces[0].memories ?? []).length >= 1);
  const restoredId = afterRestore.json.workspaces[0]?.id;
  const deleted = await req('/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'delete', id: restoredId }) });
  ok('删除返回 ok 与释放量', deleted.status === 200 && deleted.json?.ok && deleted.json.freed?.chars > 0, JSON.stringify(deleted.json));
  const afterDelete = await req('/api');
  ok('删除后工作区与归档为空', afterDelete.json.workspaces.length === 0 && afterDelete.json.archives.length === 0);
  ok('删除解绑并清 lastQuery', afterDelete.json.sessions[0]?.workspaceId === null && afterDelete.json.sessions[0]?.lastQuery === '');

  const unknown = await req('/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'nope' }) });
  ok('未知操作 400', unknown.status === 400 && unknown.json?.error, String(unknown.status));

  const bad = await fetch(base + '/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
  ok('坏 JSON 400', bad.status === 400, String(bad.status));

  const missing = await req('/nope');
  ok('未知路径 404', missing.status === 404, String(missing.status));

  const method = await fetch(base + '/api', { method: 'PUT' });
  ok('不支持方法 405', method.status === 405, String(method.status));

  await inst.flush();
  await sleep(50);
  // 落盘由 core/migration 覆盖，这里只确认 dispose 不抛错。
  for (const h of ctx.handlers['dispose'] ?? []) h();
  ok('dispose 不抛错', true);
} finally {
  await new Promise(resolve => server.close(resolve));
}

console.log(fails ? 'UI FAIL ' + fails : 'UI PASS');
process.exit(fails ? 1 : 0);
