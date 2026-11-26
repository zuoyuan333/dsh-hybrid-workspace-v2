// v2 状态：单文件 JSON + 原子写 + decisions/trace 日志；首次启动只读迁移 v1。
// 状态目录独立（$DSH_HOME/hybrid-workspace-v2），绝不改 v1 的 state.json。

import { appendFile, chmod, copyFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { hash } from './text.js';
import { normalizeMemory } from './lifecycle.js';
import { normalizePolicy } from './policy.js';

export const STATE_VERSION = 2;

const JSONL_MAX_BYTES = 2 * 1024 * 1024;
const JSONL_READ_MAX_BYTES = 512 * 1024;
const JSONL_MAX_LINE_BYTES = 64 * 1024;
const jsonlQueues = new Map();

function emptyState () {
  return { version: STATE_VERSION, createdAt: Date.now(), updatedAt: Date.now(), workspaces: [], sessions: {}, archives: [], profile: [], inbox: [], llmCalls: 0, multiTurns: 0 };
}

// P1 收件箱只排队，不调用执行器；running 落盘后重启会变成 failed，避免假装还在跑。
function normalizeInboxTask (task, now) {
  const t = task && typeof task === 'object' ? task : {};
  const text = String(t.text ?? '').slice(0, 4000);
  const status = ['queued', 'running', 'done', 'failed', 'cancelled'].includes(t.status) ? t.status : 'queued';
  const interrupted = status === 'running';
  return {
    id: String(t.id ?? ('q_' + hash(String(text) + now, 10))),
    text,
    workspaceId: String(t.workspaceId ?? ''),
    workspaceName: String(t.workspaceName ?? ''),
    status: interrupted ? 'failed' : status,
    error: interrupted ? '上次运行被中断，可重试' : String(t.error ?? ''),
    result: String(t.result ?? '').slice(0, 6000),
    simulated: t.simulated === true,
    executor: ['dsh', 'simulate'].includes(t.executor) ? t.executor : '',
    childSessionId: String(t.childSessionId ?? ''),
    parentSessionId: String(t.parentSessionId ?? ''),
    cwd: String(t.cwd ?? ''),
    createdAt: Number(t.createdAt) || now,
    startedAt: Number(t.startedAt) || 0,
    finishedAt: Number(t.finishedAt) || 0,
  };
}

function normalizeWorkspace (ws) {
  const now = Date.now();
  return {
    id: String(ws.id ?? ('ws_' + hash(String(ws.name ?? '') + now, 8))),
    name: String(ws.name ?? '未命名工作区'),
    description: String(ws.description ?? ''),
    keywords: Array.isArray(ws.keywords) ? ws.keywords.map(String).slice(0, 12) : [],
    summary: String(ws.summary ?? ''),
    turns: Array.isArray(ws.turns) ? ws.turns.map(t => { const turn = Number(t.turn) || Number(t.round) || 0; return { role: t.role === 'assistant' ? 'assistant' : 'user', text: String(t.text ?? ''), turn, round: Number(t.round) || turn, at: t.at ?? now }; }) : [],
    memories: Array.isArray(ws.memories) ? ws.memories.filter(m => m && typeof m.text === 'string').map(m => normalizeMemory(m, { now })) : [],
    exemplars: Array.isArray(ws.exemplars) ? ws.exemplars.map(e => ({ text: String(e.text ?? e), at: e.at ?? now })).slice(-20) : [],
    rounds: Number(ws.rounds) || 0,
    hits: Number(ws.hits) || 0,
    policy: normalizePolicy(ws.policy),
    createdAt: Number(ws.createdAt) || now,
    updatedAt: Number(ws.updatedAt) || now,
  };
}

export function normalizeState (input) {
  const s = input && typeof input === 'object' ? input : {};
  const out = emptyState();
  out.createdAt = Number(s.createdAt) || out.createdAt;
  out.updatedAt = Number(s.updatedAt) || out.updatedAt;
  out.llmCalls = Number(s.llmCalls) || 0;
  out.multiTurns = Number(s.multiTurns) || 0;
  out.workspaces = Array.isArray(s.workspaces) ? s.workspaces.map(normalizeWorkspace) : [];
  out.sessions = {};
  for (const [id, v] of Object.entries(s.sessions ?? {})) {
    if (!v || typeof v !== 'object') continue;
    out.sessions[id] = {
      workspaceId: v.workspaceId ?? null,
      routedAt: Number(v.routedAt) || 0,
      pending: v.pending && v.pending.id ? { id: String(v.pending.id), count: Math.max(1, Number(v.pending.count) || 1) } : null,
      newTopic: v.newTopic && typeof v.newTopic.text === 'string' && v.newTopic.text.trim()
        ? {
            text: String(v.newTopic.text).slice(0, 400),
            name: String(v.newTopic.name ?? '').slice(0, 80),
            at: Number(v.newTopic.at) || 0,
            wsId: String(v.newTopic.wsId ?? ''),
            round: Number(v.newTopic.round) || 0,
            originTurn: Number(v.newTopic.originTurn) || 0,
          }
        : null,
      lastQuery: String(v.lastQuery ?? ''),
      lastTurn: Number(v.lastTurn) || 0,
      activeWorkspaceIds: Array.isArray(v.activeWorkspaceIds) ? v.activeWorkspaceIds.map(String).slice(0, 8) : [],
      lastSegments: Array.isArray(v.lastSegments) ? v.lastSegments.slice(0, 8).map(x => ({
        index: Number(x.index) || 0, wsId: String(x.wsId ?? ''), name: String(x.name ?? ''), text: String(x.text ?? ''),
      })) : [],
      multiQuery: String(v.multiQuery ?? ''),
      recent: Array.isArray(v.recent) ? v.recent.slice(-12) : [],
    };
  }
  // 全局档案独立于任何工作区：只存 state.profile，不复制进 ws.memories。
  const rawProfile = Array.isArray(s.profile) ? s.profile : (Array.isArray(s.profile?.memories) ? s.profile.memories : []);
  out.profile = rawProfile.filter(m => m && typeof m.text === 'string').map(m => {
    const mem = normalizeMemory(m);
    mem.tier = 'profile';
    mem.layer = 'profile';
    mem.scope = 'global';
    // 旧数据/未显式取消置顶的档案默认置顶；用户取消过就尊重 false。
    mem.pinned = m.pinned !== false;
    mem.validUntil = null;
    mem.expiresAt = null;
    mem.ttlMs = 0;
    return mem;
  });
  out.archives = Array.isArray(s.archives) ? s.archives.map(a => {
    const now = Date.now();
    const turns = Array.isArray(a.turns) ? a.turns.filter(t => t && typeof t.text === 'string').map(t => {
      const turn = Number(t.turn) || Number(t.round) || 0;
      return { role: t.role === 'assistant' ? 'assistant' : 'user', text: String(t.text ?? ''), turn, round: Number(t.round) || turn, at: Number(t.at) || now };
    }) : [];
    const memories = Array.isArray(a.memories)
      ? a.memories.filter(m => m && typeof m.text === 'string').map(m => normalizeMemory(m, { now }))
      : [];
    return {
      id: String(a.id ?? ''),
      name: String(a.name ?? '未命名工作区'),
      description: String(a.description ?? ''),
      keywords: Array.isArray(a.keywords) ? a.keywords.map(String).slice(0, 12) : [],
      summary: String(a.summary ?? ''),
      turns,
      memories,
      rounds: Number(a.rounds) || 0,
      archivedAt: Number(a.archivedAt) || now,
      reason: String(a.reason ?? ''),
      restorable: a.restorable !== false,
      migratedTo: a.migratedTo && typeof a.migratedTo === 'object'
        ? { id: String(a.migratedTo.id ?? ''), name: String(a.migratedTo.name ?? '') }
        : null,
      movedTurns: Number(a.movedTurns) || 0,
      movedMemories: Number(a.movedMemories) || 0,
      contextChars: Number(a.contextChars) || 0,
      contextTokens: Number(a.contextTokens) || 0,
      policy: normalizePolicy(a.policy),
      exemplars: Array.isArray(a.exemplars) ? a.exemplars.map(e => ({ text: String(e?.text ?? e), at: Number(e?.at) || now })).slice(-20) : [],
      hits: Number(a.hits) || 0,
      createdAt: Number(a.createdAt) || Number(a.archivedAt) || now,
      updatedAt: Number(a.updatedAt) || Number(a.archivedAt) || now,
    };
  }) : [];
  out.inbox = Array.isArray(s.inbox)
    ? s.inbox.filter(t => t && typeof t.text === 'string' && t.text.trim()).slice(-200).map(t => normalizeInboxTask(t, Date.now()))
    : [];
  return out;
}

function migrateV1 (v1) {
  const s = normalizeState({ createdAt: v1.createdAt, updatedAt: v1.updatedAt });
  for (const w of v1.workspaces ?? []) {
    const ws = normalizeWorkspace({
      ...w,
      turns: (w.turns ?? []).slice(-40),
      exemplars: (w.turns ?? []).filter(t => t.role === 'user').slice(-10).map(t => ({ text: t.text, at: t.at })),
      rounds: w.rounds ?? (w.turns ?? []).filter(t => t.role === 'user').length,
    });
    for (const e of (w.ledger ?? []).slice(-40)) {
      const text = String(e.text ?? '');
      if (!text) continue;
      ws.memories.push({
        id: 'm_' + hash('v1|' + text + '|' + (e.round ?? 0), 10),
        type: /(?:结论|决定|根因|修复|改成|改为|采用|方案|确认|口径)/u.test(text) ? 'decision' : 'fact',
        text,
        keys: Array.isArray(e.keys) ? e.keys.slice(0, 12) : [],
        entities: [],
        importance: 3,
        turn: Number(e.round) || 0,
        at: Number(e.at) || Date.now(),
        status: 'active',
        source: 'v1-ledger',
      });
    }
    s.workspaces.push(ws);
  }
  for (const [id, v] of Object.entries(v1.sessions ?? {})) {
    if (!v?.workspaceId) continue;
    s.sessions[id] = { workspaceId: v.workspaceId, routedAt: v.routedAt ?? 0, pending: null, lastQuery: '', lastTurn: 0, recent: [] };
  }
  for (const a of v1.archives ?? []) {
    s.archives.push({
      id: String(a.id ?? ''), name: String(a.name ?? '未命名工作区'), description: String(a.description ?? ''),
      keywords: Array.isArray(a.keywords) ? a.keywords : [], summary: String(a.summary ?? ''),
      turns: (a.turns ?? []).map(t => ({ role: t.role === 'assistant' ? 'assistant' : 'user', text: String(t.text ?? ''), turn: Number(t.turn) || Number(t.round) || 0, round: Number(t.round) || Number(t.turn) || 0, at: Number(t.at) || Date.now() })),
      memories: (a.ledger ?? []).map(e => ({ type: 'fact', text: String(e.text ?? ''), turn: Number(e.round) || 0, at: Number(e.at) || Date.now() })),
      rounds: Number(a.rounds) || 0, archivedAt: Number(a.archivedAt) || Date.now(), reason: String(a.reason ?? 'v1'),
    });
  }
  return normalizeState(s);
}

export async function readJson (path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

export async function writeAtomic (path, data) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + '.tmp-' + process.pid + '-' + randomBytes(8).toString('hex');
  await writeFile(tmp, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

async function appendJsonlUnlocked (path, obj) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let line = JSON.stringify(obj);
  if (Buffer.byteLength(line, 'utf8') > JSONL_MAX_LINE_BYTES) {
    line = JSON.stringify({
      at: Number(obj?.at) || Date.now(),
      truncated: true,
      originalBytes: Buffer.byteLength(line, 'utf8'),
      preview: line.slice(0, 4000),
    });
  }
  await appendFile(path, line + '\n', { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);

  const file = await stat(path);
  if (file.size <= JSONL_MAX_BYTES) return;

  const handle = await open(path, 'r');
  let tail;
  try {
    const length = Math.min(file.size, JSONL_MAX_BYTES);
    const chunk = Buffer.alloc(length);
    const { bytesRead } = await handle.read(chunk, 0, length, file.size - length);
    const data = chunk.subarray(0, bytesRead);
    if (file.size <= length) {
      tail = data;
    } else {
      const newline = data.indexOf(0x0a);
      tail = newline < 0 ? Buffer.alloc(0) : data.subarray(newline + 1);
    }
  } finally {
    await handle.close();
  }

  const tmp = path + '.trim-' + process.pid + '-' + randomBytes(8).toString('hex');
  await writeFile(tmp, tail, { mode: 0o600, flag: 'wx' });
  try {
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

export function appendJsonl (path, obj) {
  const key = String(path);
  const previous = jsonlQueues.get(key) ?? Promise.resolve();
  const write = previous.catch(() => {}).then(() => appendJsonlUnlocked(key, obj));
  let tracked;
  tracked = write.finally(() => {
    if (jsonlQueues.get(key) === tracked) jsonlQueues.delete(key);
  });
  jsonlQueues.set(key, tracked);
  return tracked;
}

export async function readJsonl (path, limit = 50) {
  const count = Math.max(0, Math.floor(Number(limit) || 0));
  if (!count) return [];
  let handle;
  try {
    handle = await open(path, 'r');
    const file = await handle.stat();
    const length = Math.min(file.size, JSONL_READ_MAX_BYTES);
    if (!length) return [];
    const chunk = Buffer.alloc(length);
    const { bytesRead } = await handle.read(chunk, 0, length, file.size - length);
    let data = chunk.subarray(0, bytesRead);
    if (file.size > length) {
      const newline = data.indexOf(0x0a);
      if (newline < 0) return [];
      data = data.subarray(newline + 1);
    }
    const lines = data.toString('utf8').split('\n').filter(Boolean);
    return lines.slice(-count).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function loadOrMigrate ({ dshHome, dir: fixedDir, log = () => {} } = {}) {
  const dir = fixedDir ? String(fixedDir) : join(dshHome, 'hybrid-workspace-v2');
  const statePath = join(dir, 'state.json');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  try { await chmod(statePath, 0o600); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  let raw = null;
  try { raw = await readFile(statePath, 'utf8'); } catch { /* 不存在 */ }
  if (raw !== null) {
    try {
      const found = JSON.parse(raw);
      // null/{} /缺 workspaces 的 JSON 也是损坏状态；否则会被 normalize 成空状态并静默覆盖。
      if (found && typeof found === 'object' && !Array.isArray(found) && Array.isArray(found.workspaces)) {
        return { state: normalizeState(found), dir, statePath, migratedFrom: null };
      }
      throw new Error('invalid state shape');
    } catch {
      // 损坏的 v2 状态先留证；绝不能用旧的 v1 覆盖损坏的 v2。
      // 备份后直接重建空状态，跳过 v1 迁移，用户可手工从备份恢复。
      const backup = statePath + '.corrupt-' + Date.now();
      try { await copyFile(statePath, backup); await chmod(backup, 0o600); } catch { /* 备份失败也继续 */ }
      log('state corrupt, backup: ' + backup + '; starting empty v2 (v1 migration skipped)');
      const state = emptyState();
      await saveState(statePath, state);
      return { state, dir, statePath, migratedFrom: null, corrupt: true };
    }
  }

  const v1Path = join(dshHome, 'hybrid-workspace', 'state.json');
  const v1 = await readJson(v1Path);
  let state;
  let migratedFrom = null;
  if (v1 && Array.isArray(v1.workspaces)) {
    state = migrateV1(v1);
    migratedFrom = v1Path;
    log('migrated v1 state: ' + v1.workspaces.length + ' workspaces');
  } else {
    state = emptyState();
  }
  await saveState(statePath, state);
  return { state, dir, statePath, migratedFrom };
}

export async function saveState (statePath, state) {
  state.updatedAt = Date.now();
  await writeAtomic(statePath, JSON.stringify(state, null, 2));
}
