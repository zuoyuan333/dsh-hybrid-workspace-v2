// dsh-hybrid-workspace v2：单聊天框 + 工作区路由 + 结构化记忆 + 预算化上下文。
// 纯 ESM、零 DSH 内部 import，避免加载期依赖；面板走宿主 webServer。

import { homedir } from 'node:os';
import { join } from 'node:path';
import { clipped, hash, heuristicName } from './text.js';
import { splitSegments } from './segment.js';
import * as store from './store.js';
import * as router from './router.js';
import * as memory from './memory.js';
import * as lifecycle from './lifecycle.js';
import * as context from './context.js';
import * as migrate from './migrate.js';
import * as portable from './portable.js';
import * as policy from './policy.js';
import { buildTimeline } from './timeline.js';
import * as executor from './executor.js';
import * as governance from './governance.js';
import * as shellOs from './shell-os.js';
import { mountRoutes } from './ui.js';

export const name = 'hybrid-workspace';
export const inject = ['systemPrompt'];

export const DEFAULTS = {
  enabled: true,
  mode: 'hybrid',              // hybrid | lexical | llm
  autoCreate: true,
  ignoreSubagents: true,        // 子代理/PTC 子会话不建区、不记记忆
  panelPath: '/hybrid-workspace',
  debug: true,
  stateDir: '',                // 空 = $DSH_HOME/hybrid-workspace-v2
  maxWorkspaces: 60,
  activeLimit: 12,             // 活跃区软上限：超过后不再新建，优先复用当前区
  multiRouteIdentityHits: 2,   // 多话题分段命中旧区两个身份词时优先复用
  archiveKeep: 200,
  inboxExecutor: 'auto',        // auto/dsh = 真实子会话；simulate = 明确标注的本地模拟
  inboxMaxConcurrent: 2,        // 跨工作区最多同时跑两个子会话
  inboxTaskTimeoutMs: 600000,   // 单个子会话 10 分钟；超时主动取消
  inboxContextMaxChars: 2400,   // 子会话仅注入所选工作区的有限上下文
  inboxMemoryInject: 4,
  inboxSimulateMs: 1200,        // 仅 simulate 模式：模拟完成延迟
  routeMinScore: 0.1,
  routeAccept: 0.48,
  sameTopicAccept: 0.3,
  routeMargin: 0.1,
  switchMargin: 0.14,
  strongSwitch: 0.5,
  strongMargin: 0.3,
  unseenPenalty: 0.15,
  pendingSwitch: 2,
  newTopicConfirm: 0.12,       // 两条未命中消息的相似度，达到才升级为新工作区
  newTopicWindowMs: 30 * 60 * 1000,
  shortSticky: 12,
  exemplarKeep: 16,
  multiTopic: true,            // 一条消息里用空行/编号/“另外”显式分话题
  multiTopicMax: 3,
  segmentMinChars: 12,
  multiContextMaxChars: 3000,
  nameMaxChars: 18,
  keywordMax: 8,
  keepTurns: 12,
  compactAt: 24,
  turnMaxChars: 600,
  memoryEnabled: true,
  memoryKeep: 300,
  memoryInject: 8,
  profileKeep: 50,            // 全局档案条数
  profileInject: 4,           // 每次注入的全局档案条数
  sweepIntervalMs: 60000,    // 懒清扫节流；0 = 每次检查
  governanceEnabled: true,
  governanceAutoArchive: true, // 只自动归档空壳/长期无会话；有内容的一律进建议
  governanceEmptyTtlMs: 7 * 24 * 3600 * 1000,
  governanceStaleMs: 30 * 24 * 3600 * 1000,
  governanceLowRounds: 2,
  governanceSweepIntervalMs: 60 * 60 * 1000,
  shellAppPath: '',             // 空 = $DSH_HOME/hybrid-workspace-v2/HybridWorkspaceShell.app
  contextMaxChars: 2400,
  recentTurns: 4,
  llmJudge: false,              // hybrid 默认纯本地；明确开启后才把候选与当前消息发给模型
  llmMaxTokens: 280,
  sectionOrder: 9000,
  disableProcessHook: false,
};

// 多话题回答可能按 “1. / 2、 / 3） / ## 4” 分段；只取 1..count 的编号，
// 少于两段时返回 null，由调用方回退为只写主区。
function splitNumberedAnswer (text, count) {
  if (!Number.isFinite(count) || count < 2) return null;
  const lines = String(text ?? '').split(/\r?\n/u);
  const found = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^\s*(?:#{1,4}\s*)?(\d{1,2})\s*[.、)）:：]\s*(.*)$/u);
    const n = m ? Number(m[1]) : 0;
    if (m && n >= 1 && n <= count) {
      current = { n, lines: [m[2]] };
      found.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (new Set(found.map(x => x.n)).size < 2) return null;
  const buckets = Array.from({ length: count }, () => []);
  for (const item of found) buckets[item.n - 1].push(item.lines.join('\n').trim());
  return buckets.map(list => list.filter(Boolean).join('\n').trim());
}

function deepText (node, out = [], depth = 0, seen = new Set()) {
  if (node == null || depth > 7) return out;
  if (typeof node === 'string') return out;
  if (Array.isArray(node)) { for (const v of node) deepText(v, out, depth + 1, seen); return out; }
  if (typeof node !== 'object') return out;
  if (seen.has(node)) return out;
  seen.add(node);
  if (typeof node.text === 'string' && (node.type === 'text' || node.type === 'text-delta' || node.type === 'text-start' || !node.type)) {
    out.push(node.text);
    return out;
  }
  for (const k of Object.keys(node)) {
    if (k === 'usage' || k === 'meta' || k === 'tokens' || k === 'signature') continue;
    deepText(node[k], out, depth + 1, seen);
  }
  return out;
}

const VISIBLE_TEXT_TYPES = new Set(['text', 'text-delta', 'text-start', 'input_text', 'output_text']);

function messageText (message) {
  if (typeof message === 'string') return message;
  if (typeof message?.content === 'string') return message.content;
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const parts = blocks
    .filter(b => b && typeof b.text === 'string' && (!b.type || VISIBLE_TEXT_TYPES.has(b.type)))
    .map(b => b.text);
  if (parts.length) return parts.join('\n');
  return deepText(message).join('');
}

// dsh-ops 的 batching-guidance 等插件会以 role=user 的注入消息进入 messages。
// 它们不是用户意图，绝不能触发路由/建区/记忆；只认真正的用户来源。
const INJECTED_PREFIX = /^\s*\[Plugin context from\b/iu;
const INJECTED_SOURCE = /(?:batching-guidance|dsh-ops:step-tail)/iu;

function sourceTags (message) {
  const s = message?.source;
  if (!s) return [];
  if (typeof s === 'string') return [s];
  return [s.kind, s.name, s.id, s.plugin, s.pluginId, s.label, s.type]
    .filter(v => typeof v === 'string' && v).map(String);
}

function isInjectedMessage (message) {
  if (!message) return true;
  if (INJECTED_PREFIX.test(messageText(message))) return true;
  return sourceTags(message).some(t => INJECTED_SOURCE.test(t));
}

function isRealUserMessage (message) {
  if (!message || isInjectedMessage(message)) return false;
  if (message.source?.kind === 'user') return true;
  // 兼容没有 source 的旧消息；有非 user source 的注入消息一律不认。
  return message.role === 'user' && !message.source;
}

function lastUserText (messages) {
  const list = (messages ?? []).filter(isRealUserMessage);
  const last = list[list.length - 1];
  return last ? messageText(last).trim() : '';
}

export function apply (ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) };
  if (cfg.enabled === false) return;

  const dshHome = process.env.DSH_HOME || join(process.env.HOME || homedir(), '.dsh');
  const dir = cfg.stateDir ? String(cfg.stateDir) : join(dshHome, 'hybrid-workspace-v2');
  const statePath = join(dir, 'state.json');
  const shellAppPath = cfg.shellAppPath ? String(cfg.shellAppPath) : join(dir, 'HybridWorkspaceShell.app');
  const decisionsPath = join(dir, 'decisions.log');
  const tracePath = join(dir, 'trace.jsonl');

  let state = store.normalizeState(null);
  let loaded = false;
  let loading = null;
  let saveTimer = null;
  let saveChain = Promise.resolve();
  let saveVersion = 0;
  let savedVersion = 0;
  let lastSaveError = null;
  let traces = [];
  const seenSteps = new Set();
  const lastAssistant = new Map();
  const subagentCache = new Map();
  const subagentSessions = new Set();
  const subagentLogged = new Set();
  let lastSweepAt = 0;
  let lastGovernanceAt = 0;
  let costMeter = null;

  const log = (msg) => {
    void store.appendJsonl(decisionsPath, { at: Date.now(), msg: String(msg) }).catch(() => {
      try { ctx.logger?.warn?.('[hybrid-workspace] decision log write failed'); } catch { /* 日志失败不影响对话 */ }
    });
    try { ctx.logger?.info?.('[hybrid-workspace] ' + msg); } catch { /* 无 logger */ }
    if (cfg.debug && ctx.logger?.debug) { try { ctx.logger.debug('[hybrid-workspace] ' + msg); } catch { /* ignore */ } }
  };

  // 子代理/PTC 子会话的 prompt 也会以 role=user 进入 pre-step；它们不是用户话题。
  // 优先看 session metadata 的 origin='subagent'，再用 PTC 的 agentPreset 兜底；
  // 只对“非 session- 前缀 + ops-ptc”组合生效，避免误伤普通 GUI 会话。
  const SUBAGENT_PROMPT = /^\s*(?:You are (?:a|an|the) (?:read-only|code|review)|You are reviewing|你是(?:一个)?(?:只读|代码)?审查员)/iu;
  const isSubagent = (agent, text = '') => {
    const s = agent?.session;
    if (!s) return false;
    const sid = String(s.id ?? '');
    if (subagentCache.has(sid)) return subagentCache.get(sid);
    let hit = false;
    const meta = s.metadata ?? s.meta ?? s.header?.meta ?? {};
    if (meta && (meta.origin === 'subagent' || meta.parentSession || meta.parentSessionId || Number(meta.delegationDepth) > 0)) hit = true;
    if (!hit && (s.header?.origin === 'subagent' || s.header?.meta?.origin === 'subagent')) hit = true;
    if (!hit) {
      try {
        const rh = typeof s.requestHeader === 'function' ? s.requestHeader() : null;
        const preset = String(s.agentPreset ?? s.header?.agentPreset ?? rh?.agentPreset ?? rh?.config?.agentPreset ?? '').toLowerCase();
        if (preset === 'ops-ptc' && !/^session-/i.test(sid)) hit = true;
      } catch { /* 读取 header 失败不阻断 */ }
    }
    if (!hit && typeof s.snapshotEvents === 'function') {
      try {
        const events = s.snapshotEvents() ?? [];
        for (const ev of events.slice(-24)) {
          const m = ev?.data?.meta ?? ev?.data?.header?.meta;
          if (m && (m.origin === 'subagent' || m.parentSession || m.parentSessionId || Number(m.delegationDepth) > 0)) { hit = true; break; }
        }
      } catch { /* 读取事件失败不阻断 */ }
    }
    if (!hit && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(sid) && SUBAGENT_PROMPT.test(String(text))) hit = true;
    subagentCache.set(sid, hit);
    if (subagentCache.size > 500) subagentCache.delete(subagentCache.keys().next().value);
    if (hit) subagentSessions.add(sid);
    return hit;
  };

  const touch = () => { state.updatedAt = Date.now(); };

  // 单写者队列：定时保存/手动 flush 可能重叠，旧快照不能后落盘覆盖新状态。
  // 保存失败必须留下可观察状态：定时保存不 reject（避免 unhandled），但 flush 要抛错。
  const saveNow = async () => {
    if (!loaded) return true;
    const version = ++saveVersion;
    const run = saveChain.then(async () => {
      if (version <= savedVersion) {
        lastSaveError = null;
        return true;
      }
      try {
        await store.saveState(statePath, state);
        savedVersion = Math.max(savedVersion, version);
        lastSaveError = null;
        return true;
      } catch (error) {
        lastSaveError = { message: String(error?.message ?? error), at: Date.now() };
        log('save fail: ' + lastSaveError.message);
        return false;
      }
    });
    saveChain = run.catch(() => {});
    return run;
  };

  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; void saveNow(); }, 300);
    saveTimer.unref?.();
  };

  const flush = async () => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const ok = await saveNow();
    if (!ok) {
      throw new Error('状态保存失败：' + (lastSaveError?.message ?? '未知错误'));
    }
  };

  const ensureLoaded = async () => {
    if (loaded) return state;
    if (loading) return loading;
    loading = (async () => {
      // stateDir 必须同时用于加载和保存，否则重启会读默认目录、再用空状态覆盖自定义目录。
      const r = await store.loadOrMigrate({ dshHome, dir: cfg.stateDir ? String(cfg.stateDir) : undefined, log });
      state = r.state;
      traces = await store.readJsonl(tracePath, 30);
      loaded = true;
      if (r.migratedFrom) log('migrated from ' + r.migratedFrom);
      return state;
    })();
    try { return await loading; } finally { loading = null; }
  };

  // 懒清扫：只标记过期，不删记忆；默认一分钟最多扫一次，避免每轮写盘。
  function sweepState (now = Date.now(), force = false) {
    const every = Number(cfg.sweepIntervalMs ?? 60000);
    if (!force && every > 0 && now - lastSweepAt < every) return 0;
    lastSweepAt = now;
    let n = 0;
    for (const ws of state.workspaces) {
      try { n += memory.sweepMemories(ws, now); } catch { /* 单区异常不影响其它区 */ }
    }
    try { n += memory.sweepMemories({ memories: state.profile }, now); } catch { /* ignore */ }
    // 会话记录只增不减；没有任何绑定的旧会话保留 7 天后回收，正在用的会话不动。
    const valid = new Set(state.workspaces.map(w => w.id));
    let dropped = 0;
    for (const [id, s] of Object.entries(state.sessions)) {
      const active = (s.activeWorkspaceIds ?? []).filter(x => valid.has(x));
      const bound = s.workspaceId && valid.has(s.workspaceId);
      const last = Math.max(Number(s.routedAt) || 0,
        ...(s.recent ?? []).map(r => Number(r.at) || 0));
      if (!bound && !active.length && now - last > 7 * 24 * 3600 * 1000) {
        delete state.sessions[id];
        dropped++;
      }
    }
    let autoArchived = 0;
    if (cfg.governanceEnabled !== false && cfg.governanceAutoArchive !== false) {
      const everyGov = Number(cfg.governanceSweepIntervalMs ?? 60 * 60 * 1000);
      if (force || everyGov <= 0 || now - lastGovernanceAt >= everyGov) {
        lastGovernanceAt = now;
        try {
          const report = governance.report({ workspaces: state.workspaces, sessions: state.sessions, cfg, now });
          for (const item of report.auto) {
            const ws = state.workspaces.find(w => w.id === item.id);
            if (!ws) continue;
            if (hasPendingInboxTasks(ws.id)) continue;
            archiveWorkspace(ws, item.reason === 'stale' ? 'governance-stale' : 'governance-empty');
            autoArchived++;
          }
        } catch { /* 治理失败不影响主流程 */ }
      }
    }
    if (n || dropped || autoArchived) {
      log('sweep expired ' + n + ' memories, dropped ' + dropped + ' stale sessions, auto-archived ' + autoArchived + ' workspaces');
      touch(); scheduleSave();
    }
    return n + dropped + autoArchived;
  }

  const byId = (id) => state.workspaces.find(w => w.id === id);
  const sessionOf = (sid) => {
    if (!state.sessions[sid]) {
      state.sessions[sid] = { workspaceId: null, routedAt: 0, pending: null, lastQuery: '', lastTurn: 0, recent: [] };
    }
    return state.sessions[sid];
  };

  const trace = (entry) => {
    const row = { at: Date.now(), ...entry };
    traces.push(row);
    if (traces.length > 50) traces = traces.slice(-50);
    void store.appendJsonl(tracePath, row).catch(() => {
      try { ctx.logger?.warn?.('[hybrid-workspace] trace log write failed'); } catch { /* ignore */ }
    });
  };

  function createWorkspace (text, suggestedName) {
    const max = Math.max(1, Number(cfg.maxWorkspaces) || 60);
    while (state.workspaces.length >= max) {
      const dead = state.workspaces
        .filter(w => !hasPendingInboxTasks(w.id))
        .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0))[0];
      if (!dead) {
        log('workspace create blocked: all workspaces at capacity have queued/running inbox tasks');
        return null;
      }
      archiveWorkspace(dead, 'maxWorkspaces');
    }
    const ws = router.createWorkspace(text, { now: Date.now(), nameMaxChars: cfg.nameMaxChars, keywordMax: cfg.keywordMax });
    if (suggestedName) ws.name = clipped(suggestedName, 40);
    state.workspaces.push(ws);
    return ws;
  }

  // 注入块的实际占用：优先用最近绑定会话的最后一条消息，这样面板看到的就是下一轮会注入的内容。
  function usageOf (ws) {
    const bound = Object.values(state.sessions)
      .filter(s => s.workspaceId === ws.id)
      .sort((a, b) => (b.routedAt ?? 0) - (a.routedAt ?? 0));
    const query = bound.map(s => s.lastQuery).find(Boolean) ||
      [...(ws.turns ?? [])].reverse().find(t => t.role === 'user')?.text || '';
    return context.contextUsage(ws, query, cfg, Date.now(), state.profile);
  }

  // 统一解绑：主区、活跃区、分段、最近记录都要清；主区没了就退到剩余活跃区。
  function unbindWorkspace (wsId) {
    for (const s of Object.values(state.sessions)) {
      const wasPrimary = s.workspaceId === wsId;
      // 同时清掉历史上已删除/归档的残影，避免回退到不存在的工作区。
      const active = (s.activeWorkspaceIds ?? []).filter(id => id !== wsId && Boolean(byId(id)));
      s.activeWorkspaceIds = [...new Set(active)];
      s.lastSegments = (s.lastSegments ?? []).filter(x => x.wsId !== wsId);
      s.recent = (s.recent ?? []).filter(r => r.wsId !== wsId);
      if (wasPrimary) {
        s.workspaceId = s.activeWorkspaceIds[0] ?? null;
        s.pending = null;
        if (!s.workspaceId) { s.lastQuery = ''; s.lastTurn = 0; }
      }
      if (s.activeWorkspaceIds.length < 2) { s.lastSegments = []; s.multiQuery = ''; }
    }
  }

  // 归档是软删除：保留快照、解绑会话，面板可恢复。
  function archiveWorkspace (ws, reason = 'manual') {
    const usage = usageOf(ws);
    state.workspaces = state.workspaces.filter(w => w.id !== ws.id);
    state.archives.unshift({
      id: ws.id, name: ws.name, description: ws.description, keywords: ws.keywords,
      summary: ws.summary,
      // 恢复必须能回到归档前的状态：保留全量对话/记忆（含 superseded/expired），不能只留最近几条。
      turns: (ws.turns ?? []).map(t => ({ ...t })),
      memories: (ws.memories ?? []).map(m => ({ ...m })),
      rounds: ws.rounds ?? 0, archivedAt: Date.now(), reason,
      contextChars: usage.chars, contextTokens: usage.tokens,
      restorable: true, migratedTo: null, movedTurns: 0, movedMemories: 0,
      policy: ws.policy, exemplars: (ws.exemplars ?? []).map(e => ({ ...e })), hits: ws.hits ?? 0,
      createdAt: ws.createdAt, updatedAt: ws.updatedAt,
    });
    if (state.archives.length > cfg.archiveKeep) state.archives = state.archives.slice(0, cfg.archiveKeep);
    unbindWorkspace(ws.id);
    log('archive ws ' + ws.id + ' (' + ws.name + ') reason=' + reason);
    touch();
    return usage;
  }

  // 迁移归档：只留元数据，避免原文在归档区重复注入；只有搬空才不可恢复。
  function archiveMigrated (source, into, moved) {
    const usage = usageOf(source);
    const remainingTurns = source.turns?.length ?? 0;
    const remainingMemories = source.memories?.length ?? 0;
    const restorable = remainingTurns + remainingMemories > 0;
    state.archives = state.archives.filter(a => a.id !== source.id);
    state.archives.unshift({
      id: source.id, name: source.name, description: source.description, keywords: source.keywords,
      summary: restorable ? (source.summary ?? '') : '',
      turns: restorable ? (source.turns ?? []).map(t => ({ ...t })) : [],
      memories: restorable ? (source.memories ?? []).map(m => ({ ...m })) : [],
      rounds: source.rounds ?? 0, archivedAt: Date.now(),
      reason: restorable ? 'migrated-leftover' : 'migrated',
      contextChars: usage.chars, contextTokens: usage.tokens,
      restorable,
      policy: source.policy, exemplars: restorable ? (source.exemplars ?? []).map(e => ({ ...e })) : [], hits: source.hits ?? 0,
      createdAt: source.createdAt, updatedAt: source.updatedAt,
      migratedTo: { id: into.id, name: into.name },
      movedTurns: Number(moved?.turns) || 0,
      movedMemories: Number(moved?.memories) || 0,
    });
    if (state.archives.length > cfg.archiveKeep) state.archives = state.archives.slice(0, cfg.archiveKeep);
    state.workspaces = state.workspaces.filter(w => w.id !== source.id);
    log('archive migrated ws ' + source.id + ' -> ' + into.id + ' moved=' + (moved?.turns ?? 0) + '/' + (moved?.memories ?? 0));
    touch();
    return { id: source.id, name: source.name, restorable, remainingTurns, remainingMemories };
  }

  function rebindSessions (sourceIds, into) {
    const ids = new Set(sourceIds);
    for (const s of Object.values(state.sessions)) {
      if (ids.has(s.workspaceId)) {
        s.workspaceId = into.id;
        s.pending = null;
        s.routedAt = Date.now();
      }
      s.activeWorkspaceIds = [...new Set((s.activeWorkspaceIds ?? []).map(id => ids.has(id) ? into.id : id))];
      s.lastSegments = (s.lastSegments ?? []).map(x => ids.has(x.wsId) ? { ...x, wsId: into.id, name: into.name } : x);
    }
  }

  function appendTurn (ws, role, text, turn) {
    const t = clipped(text, cfg.turnMaxChars);
    if (!t) return;
    if (!Array.isArray(ws.turns)) ws.turns = [];
    ws.turns.push({ role, text: t, at: Date.now(), turn: Number(turn) || ws.rounds || 0 });
    if (ws.turns.length > 200) ws.turns = ws.turns.slice(-200);
  }

  async function classify (agent, text, session, signal, rankedCandidates = []) {
    if (cfg.mode === 'lexical' || (cfg.mode !== 'llm' && cfg.llmJudge !== true)) return null;
    const target = agent?.session?.requestHeader?.()?.config;
    if (!target?.provider || !target?.model) return null;
    const current = byId(session.workspaceId);
    // 只把词面排名前 5 的 ID/名称交给模型；不外发项目描述、例子、记忆或旧对话。
    const catalog = (rankedCandidates ?? []).slice(0, 5)
      .map(x => ({ id: String(x?.id ?? ''), name: clipped(x?.name, 40) }))
      .filter(x => x.id && x.name);
    if (current) {
      const currentCandidate = catalog.find(x => x.id === current.id);
      if (currentCandidate) currentCandidate.current = true;
      else {
        if (catalog.length >= 5) catalog.pop();
        catalog.push({ id: current.id, name: clipped(current.name, 40), current: true });
      }
    }
    if (!catalog.length) return null;

    const sys = [
      '你是消息路由器。判断用户的新消息应该归入哪个工作区，或新建，或留在当前区。',
      '只输出一行 JSON，不要解释、不要代码块：',
      '{"id":"<工作区id | new | stay>","name":"<仅 id=new 时给 2-8 字工作区名>","confidence":0~1,"reason":"<=20字"}',
      '候选项只含 ID 与名称，当前区会标记 current:true。选择最匹配的候选；确实是全新主题才 new；含义模糊、指代（"继续""那个""改一下"）优先 stay 当前区。',
    ].join('\n');
    const user = [
      '候选工作区（最多 5 个；当前区标记为 current:true）：',
      JSON.stringify(catalog, null, 1),
      '用户新消息：',
      clipped(text, 700),
    ].filter(Boolean).join('\n');

    let out = '';
    try {
      state.llmCalls = (state.llmCalls ?? 0) + 1;
      for await (const chunk of ctx.llm.stream({
        provider: target.provider,
        model: target.model,
        messages: [
          { role: 'system', content: [{ type: 'text', text: sys }] },
          { role: 'user', content: [{ type: 'text', text: user }] },
        ],
        maxTokens: cfg.llmMaxTokens,
        sessionId: agent?.session?.id,
        purpose: 'hybrid-workspace-route',
        ...(signal ? { signal } : {}),
      })) {
        if (typeof chunk?.text === 'string') out += chunk.text;
        else if (typeof chunk?.delta?.text === 'string') out += chunk.delta.text;
      }
    } catch (error) {
      log('llm route fail: ' + String(error?.message ?? error));
      return null;
    }
    const match = out.match(/\{[\s\S]*\}/u);
    if (!match) { log('llm route unparsable: ' + clipped(out, 120)); return null; }
    try {
      const p = JSON.parse(match[0]);
      return {
        id: typeof p.id === 'string' ? p.id : null,
        name: typeof p.name === 'string' ? p.name : null,
        confidence: typeof p.confidence === 'number' ? p.confidence : 0.5,
        reason: typeof p.reason === 'string' ? p.reason : '',
      };
    } catch { return null; }
  }

  async function decideFor (agent, text, session, signal) {
    const currentWs = session?.workspaceId ? byId(session.workspaceId) : null;
    let decision = router.decideRoute({
      workspaces: state.workspaces,
      session,
      text,
      cfg: {
        routeMinScore: cfg.routeMinScore, routeAccept: cfg.routeAccept, sameTopicAccept: cfg.sameTopicAccept,
        routeMargin: cfg.routeMargin, switchMargin: cfg.switchMargin, strongSwitch: cfg.strongSwitch,
        strongMargin: cfg.strongMargin, unseenPenalty: cfg.unseenPenalty,
        pendingSwitch: cfg.pendingSwitch, shortSticky: cfg.shortSticky,
        newTopicConfirm: cfg.newTopicConfirm, newTopicWindowMs: cfg.newTopicWindowMs,
        autoSwitch: currentWs ? policy.mayAutoSwitch(currentWs) : true,
      },
    });
    const explainBase = {
      queryTerms: Array.isArray(decision.queryTerms) ? decision.queryTerms.slice(0, 20) : [],
      currentScore: decision.currentScore ?? null,
    };
    const locked = Boolean(currentWs && !policy.mayAutoSwitch(currentWs));
    if (locked && decision.action === 'ask-llm') {
      decision = { action: 'stay', wsId: session.workspaceId, how: 'locked', scores: decision.scores ?? [], pending: null };
    }
    let usedLlm = false;
    const shouldJudge = cfg.mode === 'llm'
      ? state.workspaces.length > 0
      : cfg.mode !== 'lexical' && cfg.llmJudge === true && decision.action === 'ask-llm';
    if (!locked && shouldJudge) {
      const judged = await classify(agent, text, session, signal, decision.scores);
      if (judged) {
        usedLlm = true;
        state.llmCalls = state.llmCalls ?? 0;
        if (judged.id === 'new' && judged.confidence >= 0.6) {
          decision = { action: 'new', how: 'llm-new', name: judged.name, confidence: judged.confidence, scores: decision.scores ?? [] };
        } else if (judged.id === 'stay') {
          decision = { action: 'stay', wsId: session.workspaceId, how: 'llm-stay', confidence: judged.confidence, scores: decision.scores ?? [], pending: null };
        } else {
          const target = byId(judged.id);
          if (target && judged.confidence >= 0.5) {
            decision = { action: 'route', wsId: target.id, ws: target, how: 'llm-route', confidence: judged.confidence, scores: decision.scores ?? [], pending: null };
          } else if (!session.workspaceId && judged.confidence >= 0.6) {
            decision = { action: 'new', how: 'llm-new', name: judged.name, confidence: judged.confidence, scores: decision.scores ?? [] };
          } else {
            decision = { action: 'stay', wsId: session.workspaceId, how: 'llm-uncertain', confidence: judged.confidence, scores: decision.scores ?? [], pending: null };
          }
        }
      } else if (decision.action === 'ask-llm') {
        decision = session.workspaceId
          ? { action: 'stay', wsId: session.workspaceId, how: 'llm-fail', scores: decision.scores ?? [], pending: null }
          : { action: 'new', how: 'llm-fail', scores: decision.scores ?? [] };
      }
    } else if (!locked && decision.action === 'ask-llm') {
      // LLM 关闭时保留原有确定性兜底：当前会话留在当前区，无绑定区时建立首个区。
      decision = session.workspaceId
        ? { action: 'stay', wsId: session.workspaceId, how: 'llm-disabled', scores: decision.scores ?? [], pending: null }
        : { action: 'new', how: 'llm-disabled', scores: decision.scores ?? [] };
    }
    return { decision: { ...decision, ...explainBase }, usedLlm };
  }

  function applyDecision (session, text, turn, decision, { sid = 'unknown', usedLlm = false, segment = null } = {}) {
    if (!Array.isArray(session.recent)) session.recent = [];
    let ws = null;
    // autoCreate=false 时不能把消息丢掉：有当前区就留在当前区记下来，
    // 没有任何区才真的无从归属。否则关闭自动建区会让后续消息完全不进上下文。
    if (decision.action === 'new' && !cfg.autoCreate) {
      const cur = byId(session.workspaceId);
      if (!cur) { log('new topic but autoCreate=false and no current workspace'); return null; }
      log('new topic but autoCreate=false: stay ' + cur.id);
      decision = { action: 'stay', wsId: cur.id, how: 'auto-create-off', scores: decision.scores ?? [] };
    }
    if (decision.action === 'new') {
      const proposed = clipped(decision.name || heuristicName(text, cfg.nameMaxChars ?? 18), 40);
      const dup = router.findDuplicateWorkspace(state.workspaces, proposed);
      if (dup) {
        decision = { ...decision, action: 'route', ws: dup, wsId: dup.id, how: 'duplicate-name', pending: null };
        log('new topic reuses duplicate ws ' + dup.id + ' (' + dup.name + ')');
      } else if (cfg.activeLimit > 0 && state.workspaces.length >= cfg.activeLimit) {
        const fallback = byId(session.workspaceId) ?? state.workspaces.slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
        if (fallback) {
          decision = { ...decision, action: 'route', ws: fallback, wsId: fallback.id, how: 'active-limit', pending: null };
          log('active limit ' + cfg.activeLimit + ': stay ' + fallback.id);
        }
      }
    }
    if (decision.action === 'new') {
      // 两跳确认的新话题：第一条消息暂存在旧区，建区时搬移或安全复制到新区。
      const pending = session.newTopic;
      const confirmed = decision.how === 'new-topic-confirmed' && pending?.text;
      ws = createWorkspace(confirmed ? pending.text : text, decision.name || '');
      if (!ws) {
        // Do not leave this session bound to its previous workspace: otherwise
        // the failed new-topic route would inject that unrelated context.
        session.workspaceId = null;
        session.activeWorkspaceIds = [];
        session.lastSegments = [];
        session.multiQuery = '';
        session.pending = null;
        if (!confirmed) session.newTopic = null;
        session.lastQuery = text;
        session.lastTurn = turn;
        touch(); scheduleSave();
        trace({ sessionId: sid, text: clipped(text, 100), how: 'capacity-protected', wsId: null, name: null, scores: decision.scores ?? [] });
        return null;
      }
      if (confirmed) {
        const from = byId(pending.wsId);
        if (from && from.id !== ws.id) {
          if (hasPendingInboxTasks(from.id)) {
            // Two-hop routing is an implicit migration. Preserve the locked
            // source and copy only its provisional conversation into the new
            // workspace while a child task still references the source.
            const round = Number(pending.round) || 0;
            const provisional = (from.turns ?? []).filter(t =>
              (Number(t.turn ?? t.round) || 0) === round);
            if (provisional.some(t => String(t.role ?? 'user') === 'user')) {
              ws.turns = [...provisional.map(t => ({ ...t, turn: 1, round: 1 })), ...(ws.turns ?? [])];
              ws.rounds = 1;
              log('copy provisional turn from locked ' + from.id + ' to ' + ws.id);
            }
          } else {
            const moved = router.takeRoundTurns(from, ws, pending.round);
            if (pending.originTurn) {
              const kept = [];
              const movedMem = [];
              for (const m of from.memories ?? []) {
                if (m.origin?.sessionId === sid && Number(m.origin.turn) === Number(pending.originTurn)) movedMem.push(m);
                else kept.push(m);
              }
              if (movedMem.length) {
                from.memories = kept;
                ws.memories = [...(ws.memories ?? []), ...movedMem];
              }
            }
            if (moved) {
              from.updatedAt = Date.now();
              log('move provisional turn from ' + from.id + ' to ' + ws.id + ' (' + moved + ' turns)');
            }
          }
        }
      }
      session.workspaceId = ws.id;
      session.routedAt = Date.now();
      session.pending = null;
      session.newTopic = null;
      ws.hits = (ws.hits ?? 0) + 1;
      log('new ws ' + ws.id + ' (' + ws.name + ') how=' + decision.how);
    } else if (decision.action === 'route' && decision.ws) {
      ws = decision.ws;
      session.workspaceId = ws.id;
      session.routedAt = Date.now();
      session.pending = null;
      session.newTopic = null;
      ws.hits = (ws.hits ?? 0) + 1;
      router.addExemplar(ws, text, { exemplarKeep: cfg.exemplarKeep });
      log('route ' + ws.id + ' how=' + decision.how);
    } else {
      ws = byId(session.workspaceId);
      if (decision.pending) session.pending = decision.pending;
      else if (decision.how !== 'pending-switch') session.pending = null;
      if (decision.newTopic !== undefined) session.newTopic = decision.newTopic;
      else session.newTopic = null;
      if (ws) ws.hits = (ws.hits ?? 0) + 1;
    }
    const scores = Array.isArray(decision.scores) ? decision.scores : [];
    const top = scores[0] ?? null;
    const traceBase = {
      sessionId: sid, text: clipped(text, 100), how: decision.how, scores, llm: usedLlm,
      queryTerms: Array.isArray(decision.queryTerms) ? decision.queryTerms.slice(0, 20) : [],
      currentScore: decision.currentScore ?? null,
      explain: {
        matched: (top?.matched ?? []).slice(0, 8),
        coverage: top?.coverage ?? 0,
        topScore: top?.score ?? 0,
        margin: scores.length > 1 ? Math.round(((top?.score ?? 0) - (scores[1]?.score ?? 0)) * 1000) / 1000 : null,
      },
    };
    if (segment) {
      traceBase.multi = true;
      traceBase.segmentIndex = segment.index;
      traceBase.segmentCount = segment.count;
    }
    if (!ws) {
      session.lastQuery = text;
      session.lastTurn = turn;
      touch(); scheduleSave();
      trace({ ...traceBase, wsId: null, name: null });
      return null;
    }

    ws.rounds = (ws.rounds ?? 0) + 1;
    appendTurn(ws, 'user', text, ws.rounds);
    if (cfg.memoryEnabled) {
      try { memory.rememberText(ws, text, { role: 'user', turn: ws.rounds, max: 3, cfg, profile: state.profile, origin: { sessionId: sid, turn, role: 'user' } }); } catch (error) { log('memory user fail: ' + String(error?.message ?? error)); }
    }
    memory.compactTurns(ws, cfg);
    session.lastQuery = text;
    session.lastTurn = turn;
    session.recent.push({ wsId: ws.id, at: Date.now(), how: decision.how });
    if (session.recent.length > 12) session.recent = session.recent.slice(-12);
    ws.updatedAt = Date.now();
    // 记录暂存轮次，供下一次 new-topic-confirmed 把首条消息搬进新区。
    if (session.newTopic && ws) {
      session.newTopic = { ...session.newTopic, wsId: ws.id, round: ws.rounds, originTurn: turn };
    }
    touch(); scheduleSave();
    trace({ ...traceBase, wsId: ws.id, name: ws.name });
    return ws;
  }

  const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  function resolveSegmentRef (session, text) {
    const list = session?.lastSegments;
    if (!Array.isArray(list) || list.length < 2) return null;
    const m = String(text).match(/第\s*([一二两三四五六七八九十\d]+)\s*(?:个|条|项|件|点)/u);
    if (!m) return null;
    let n = Number(m[1]);
    if (!Number.isFinite(n)) n = CN_NUM[m[1]] ?? 0;
    if (!n || n < 1 || n > list.length) return null;
    const item = list[n - 1];
    const ws = byId(item?.wsId);
    return ws ? { ws, item, n } : null;
  }

  async function routeMessage (agent, text, turn, signal) {
    const sid = agent?.session?.id ?? 'unknown';
    const session = sessionOf(sid);
    const currentWs = session.workspaceId ? byId(session.workspaceId) : null;
    const locked = Boolean(currentWs && !policy.mayAutoSwitch(currentWs));
    const segments = locked ? [{ index: 0, text }] : splitSegments(text, cfg);
    if (locked) log('auto-switch locked by policy: stay ' + currentWs.id);

    // “第二个呢/上面第 2 条”指上一条多话题消息里的分区；切到该区并保持单区上下文。
    const ref = !locked && segments.length <= 1 ? resolveSegmentRef(session, text) : null;
    if (ref?.ws) {
      const decision = { action: 'route', ws: ref.ws, wsId: ref.ws.id, how: 'segment-ref', scores: [], pending: null };
      const ws = applyDecision(session, text, turn, decision, { sid });
      if (ws) {
        session.workspaceId = ws.id;
        session.activeWorkspaceIds = [ws.id];
        session.multiQuery = '';
      }
      touch(); scheduleSave();
      return ws;
    }

    if (segments.length <= 1) {
      const { decision, usedLlm } = await decideFor(agent, text, session, signal);
      const ws = applyDecision(session, text, turn, decision, { sid, usedLlm });
      session.activeWorkspaceIds = ws ? [ws.id] : [];
      session.lastSegments = [];
      session.multiQuery = '';
      touch(); scheduleSave();
      return ws;
    }

    // 多话题：每段都以进入本条消息前的当前区为候选，但不继承前一段新建/切换的结果。
    // 否则“已有话题 + 新话题”这类消息会把已有话题再次建成新区。
    const baseView = {
      workspaceId: session.workspaceId ?? null,
      routedAt: session.routedAt ?? 0,
      pending: null,
      newTopic: null,
      lastQuery: session.lastQuery ?? '',
      lastTurn: session.lastTurn ?? 0,
      recent: Array.isArray(session.recent) ? [...session.recent] : [],
    };
    const baseCurrent = baseView.workspaceId ? byId(baseView.workspaceId) : null;
    const results = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const view = { ...baseView, recent: [...baseView.recent] };
      let { decision, usedLlm } = await decideFor(agent, seg.text, view, signal);
      // 多话题消息的每一段都应独立成题。当前区若只靠历史记忆命中（身份字段几乎没有命中），
      // 不能把新话题吞回去；优先落到真实匹配的别的区，否则新建。
      if (baseCurrent && (decision.action === 'stay' || (decision.action === 'route' && decision.wsId === baseCurrent.id))) {
        const currentScore = (decision.scores ?? []).find(x => x.id === baseCurrent.id);
        const identityHits = router.identityMatches(baseCurrent, seg.text);
        if (!currentScore?.exact && identityHits.length < 2) {
          // 多话题里用户已经显式分段，旧区命中两个身份词就优先复用；
          // 不能因为分数没到单条切换的 routeAccept 就新建 D。
          const target = router.pickMultiTarget({
            scores: decision.scores, currentId: baseCurrent.id, text: seg.text, workspaces: state.workspaces, cfg,
          });
          decision = target
            ? { ...decision, action: 'route', ws: target, wsId: target.id, how: 'multi-route', pending: null }
            : { ...decision, action: 'new', ws: null, wsId: null, how: 'multi-new', pending: null };
        }
      }
      const ws = applyDecision(view, seg.text, turn, decision, {
        sid, usedLlm, segment: { index: i, count: segments.length },
      });
      // 两段落到同一区时只保留一次，避免 activeWorkspaceIds 重复。
      if (ws && !results.some(r => r.ws.id === ws.id)) results.push({ ws, text: seg.text, how: decision.how });
    }
    if (!results.length) {
      session.lastQuery = text;
      session.lastTurn = turn;
      touch(); scheduleSave();
      return null;
    }

    const primary = results[0].ws;
    session.workspaceId = primary.id;
    session.routedAt = Date.now();
    session.pending = null;
    session.newTopic = null;
    session.lastQuery = text;
    session.lastTurn = turn;
    session.recent.push({ wsId: primary.id, at: Date.now(), how: 'multi-topic' });
    if (session.recent.length > 12) session.recent = session.recent.slice(-12);
    if (results.length > 1) {
      session.activeWorkspaceIds = [...new Set(results.map(r => r.ws.id))];
      session.lastSegments = results.map((r, i) => ({ index: i, wsId: r.ws.id, name: r.ws.name, text: clipped(r.text, 200) }));
      session.multiQuery = text;
      state.multiTurns = (state.multiTurns ?? 0) + 1;
      log('multi-topic ' + results.length + '/' + segments.length + ' -> ' + session.activeWorkspaceIds.join(','));
    } else {
      session.activeWorkspaceIds = [primary.id];
      session.lastSegments = [];
      session.multiQuery = '';
    }
    touch(); scheduleSave();
    return primary;
  }

  async function onAssistant (session, event) {
    if (!event || event.type !== 'assistant/message') return;
    const sid = typeof session === 'string' ? session : session?.id;
    if (!sid) return;
    if (subagentSessions.has(String(sid))) return;
    const s = state.sessions[sid];
    if (!s?.workspaceId) return;
    const ws = byId(s.workspaceId);
    if (!ws) return;
    const payload = event.data?.message ?? event.data;
    if (isInjectedMessage(payload)) return;
    const text = messageText(payload).trim();
    // 只落可见正文；reasoning/thinking 块绝不能写进工作区或记忆。
    if (!text) return;
    const hostTurn = Number(event.turn ?? event.data?.turn ?? payload?.turn ?? s.lastTurn) || Number(s.lastTurn) || 0;
    const key = sid + ':' + hash(text, 10);
    const last = lastAssistant.get(sid);
    if (last && last.key === key && Date.now() - last.at < 5000) return;
    lastAssistant.set(sid, { key, at: Date.now() });
    if (lastAssistant.size > 50) lastAssistant.delete(lastAssistant.keys().next().value);

    // 多话题回答通常按编号覆盖多个区：能按编号拆就各落各的；
    // 拆不出来时只写主区，避免把整段回答复制进每个区造成串味。
    // 每个活跃区从自己的那段回答里抽记忆；没有编号时只有主区有回答。
    const targets = [];
    const active = Array.isArray(s.activeWorkspaceIds) ? s.activeWorkspaceIds : [];
    for (const id of (active.length > 1 ? active : [s.workspaceId])) {
      const target = byId(id);
      if (target && !targets.some(x => x.id === target.id)) targets.push(target);
    }
    if (!targets.length) targets.push(ws);
    const sections = targets.length > 1 ? splitNumberedAnswer(text, targets.length) : null;
    for (const [index, target] of targets.entries()) {
      const own = sections ? sections[index] : (index === 0 ? text : '');
      const body = sections
        ? (own || ('（第 ' + (index + 1) + ' 个话题本轮没有单独回答）'))
        : own;
      if (!body) continue;
      appendTurn(target, 'assistant', body, target.rounds ?? ws.rounds ?? 0);
      if (cfg.memoryEnabled && own) {
        try { memory.rememberText(target, own, { role: 'assistant', turn: target.rounds ?? ws.rounds, max: 3, cfg, profile: state.profile, origin: { sessionId: sid, turn: hostTurn, role: 'assistant' } }); } catch (error) { log('memory assistant fail: ' + String(error?.message ?? error)); }
      }
      memory.compactTurns(target, cfg);
      target.updatedAt = Date.now();
    }
    touch(); scheduleSave();
  }

  /* ── P2 收件箱：每个任务一个 DSH 子会话；跨区最多 2 并发，同区串行 ── */
  const inboxRuns = new Map(); // taskId -> { taskId, workspaceId, controller }
  let inboxNext = null;
  let inboxAll = false;
  let inboxPumping = false;

  function pendingInboxTasks (workspaceId) {
    const tasks = (state.inbox ?? []).filter(task => task.workspaceId === workspaceId &&
      (task.status === 'queued' || task.status === 'running'));
    const known = new Set(tasks.map(task => task.id));
    // cancel / clear can update or remove the persisted row before the child
    // executor has observed abort and settled. Keep the workspace locked until
    // the runtime run is removed from inboxRuns in its finally block.
    for (const run of inboxRuns.values()) {
      if (run.workspaceId === workspaceId && !known.has(run.taskId)) {
        tasks.push({ id: run.taskId, status: 'running' });
      }
    }
    return tasks;
  }

  function hasPendingInboxTasks (workspaceId) {
    return pendingInboxTasks(workspaceId).length > 0;
  }

  function inboxLockError (workspaceId) {
    const tasks = pendingInboxTasks(workspaceId);
    if (!tasks.length) return '';
    return '该工作区有排队或运行中的收件箱任务（' + tasks.length + ' 个），请先取消或等待完成。';
  }

  const inboxMaxConcurrent = () => Math.max(1, Math.min(4, Number(cfg.inboxMaxConcurrent) || 2));
  const inboxMode = () => cfg.inboxExecutor === 'simulate' ? 'simulate' : 'dsh';

  function inboxStatus () {
    const mode = inboxMode();
    const probe = mode === 'simulate'
      ? { available: true, reason: '' }
      : executor.probeExecutor(ctx);
    return { mode, available: probe.available, reason: probe.reason, maxConcurrent: inboxMaxConcurrent(), active: inboxRuns.size };
  }

  function scheduleInboxPump () {
    if (inboxNext) return;
    inboxNext = setTimeout(() => {
      inboxNext = null;
      void pumpInbox({ all: true }).catch(error => log('inbox pump fail: ' + String(error?.message ?? error)));
    }, 120);
    inboxNext.unref?.();
  }

  function trimInbox () {
    if (!Array.isArray(state.inbox)) state.inbox = [];
    while (state.inbox.length > 200) {
      const i = state.inbox.findIndex(t => t.status !== 'queued' && t.status !== 'running');
      if (i < 0) break;
      state.inbox.splice(i, 1);
    }
  }

  function simulateInbox (signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('cancelled')); return; }
      const finish = () => { cleanup(); resolve(); };
      const timer = setTimeout(finish, Math.max(50, Number(cfg.inboxSimulateMs) || 1200));
      timer.unref?.();
      const onAbort = () => { clearTimeout(timer); cleanup(); reject(new Error('cancelled')); };
      const cleanup = () => signal?.removeEventListener?.('abort', onAbort);
      signal?.addEventListener?.('abort', onAbort, { once: true });
    });
  }

  function startInboxTask (task, ws) {
    const mode = inboxMode();
    const controller = new AbortController();
    inboxRuns.set(task.id, { taskId: task.id, workspaceId: ws.id, controller });
    task.status = 'running';
    task.startedAt = Date.now();
    task.finishedAt = 0;
    task.error = '';
    task.result = '';
    task.simulated = false;
    task.executor = mode;
    task.childSessionId = '';
    task.parentSessionId = '';
    touch();
    log('inbox run ' + task.id + ' ws=' + ws.id + ' mode=' + mode);

    const settle = async () => {
      let outcome = null;
      let failure = null;
      try {
        if (mode === 'simulate') {
          await simulateInbox(controller.signal);
          outcome = { status: 'done', result: '模拟执行器：已按顺序出队（未调用 DSH 执行器）。', error: '', simulated: true };
        } else {
          outcome = await executor.runInboxTask({
            ctx, cfg, task, workspace: ws, sessions: state.sessions, signal: controller.signal, log,
            onChild: info => {
              task.executor = 'dsh';
              task.childSessionId = info.childSessionId;
              task.parentSessionId = info.parentSessionId;
              task.cwd = info.cwd || '';
              touch();
              void flush().catch(error => log('inbox flush fail: ' + String(error?.message ?? error)));
            },
          });
        }
      } catch (error) {
        failure = error;
      }
      try {
        const current = (state.inbox ?? []).find(t => t.id === task.id);
        if (current) {
          if (outcome?.childSessionId) current.childSessionId = outcome.childSessionId;
          if (outcome?.parentSessionId) current.parentSessionId = outcome.parentSessionId;
          if (current.status === 'running') {
            if (!outcome) {
              current.status = 'failed';
              current.error = '子会话执行失败：' + String(failure?.message ?? failure);
            } else if (outcome.status === 'done') {
              current.status = 'done';
              current.result = outcome.result;
              current.error = '';
              current.simulated = outcome.simulated === true;
            } else if (outcome.status === 'cancelled') {
              current.status = 'cancelled';
              current.error = outcome.error || '用户取消';
              current.result = '';
            } else {
              current.status = 'failed';
              current.error = outcome.error || '子会话执行失败';
              current.result = outcome.result ?? '';
            }
            current.finishedAt = Date.now();
            current.executor = current.executor || mode;
            log('inbox ' + current.status + ' ' + current.id + ' ws=' + current.workspaceId + (current.error ? ' error=' + current.error : ''));
          }
        }
      } finally {
        inboxRuns.delete(task.id);
        touch();
        try { await flush(); } catch (error) { log('inbox flush fail: ' + String(error?.message ?? error)); }
        if (inboxAll) scheduleInboxPump();
      }
    };
    return settle().catch(error => log('inbox settle fail: ' + String(error?.message ?? error)));
  }

  async function pumpInbox ({ all = false } = {}) {
    if (all) inboxAll = true;
    if (inboxPumping) return { ok: true, busy: true };
    inboxPumping = true;
    const started = [];
    const failed = [];
    try {
      if (!Array.isArray(state.inbox)) state.inbox = [];
      for (;;) {
        if (inboxRuns.size >= inboxMaxConcurrent()) break;
        let task = null;
        for (const candidate of state.inbox.filter(t => t.status === 'queued')) {
          const target = candidate.workspaceId ? byId(candidate.workspaceId) : null;
          if (!target) {
            candidate.status = 'failed';
            candidate.finishedAt = Date.now();
            candidate.error = candidate.workspaceId ? '工作区已不存在：' + candidate.workspaceId : '未锁定工作区';
            failed.push(candidate.id);
            touch();
            await flush();
            log('inbox failed ' + candidate.id + ' ' + candidate.error);
            continue;
          }
          if ([...inboxRuns.values()].some(run => run.workspaceId === candidate.workspaceId)) continue;
          task = candidate;
          break;
        }
        if (!task) break;
        const target = byId(task.workspaceId);
        startInboxTask(task, target);
        started.push(task.id);
        await flush();
        if (!all) break;
      }
    } finally {
      inboxPumping = false;
    }
    const extra = failed.length ? { failed: failed[0], failedIds: failed } : {};
    if (started.length) return { ok: true, started: started[0], startedIds: started, ...extra };
    if (inboxRuns.size) return { ok: true, busy: true, running: [...inboxRuns.keys()], ...extra };
    if (!state.inbox.some(t => t.status === 'queued')) {
      inboxAll = false;
      return { ok: true, empty: true, ...extra };
    }
    return { ok: true, busy: true, locked: true, ...extra };
  }

  async function advanceInbox (all = false) {
    return await pumpInbox({ all });
  }

  async function snapshot ({ sweep = true, archiveSummaries = false } = {}) {
    await ensureLoaded();
    if (sweep) sweepState();
    const workspaces = state.workspaces.slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).map(w => {
      const usage = usageOf(w);
      return {
        id: w.id, name: w.name, description: w.description, keywords: w.keywords, summary: w.summary,
        rounds: w.rounds, hits: w.hits, createdAt: w.createdAt, updatedAt: w.updatedAt,
        sessions: Object.values(state.sessions).filter(s => s.workspaceId === w.id).length,
        contextChars: usage.chars, contextTokens: usage.tokens, contextMaxChars: usage.max, contextPct: usage.pct,
        contextBreakdown: usage.breakdown,
        policy: policy.policyView(w),
        timeline: buildTimeline(w),
        memories: (w.memories ?? []).slice().sort((a, b) => (b.status === 'active') - (a.status === 'active') || (b.turn ?? 0) - (a.turn ?? 0)).slice(0, 80)
          .map(m => ({ ...m, ttlLeftMs: lifecycle.remainingMs(m) })),
        memoryStats: memory.stats(w),
        exemplars: (w.exemplars ?? []).slice(-10),
        turns: (w.turns ?? []).slice(-8),
      };
    });
    const profile = (state.profile ?? []).slice()
      .sort((a, b) => (b.pinned === true) - (a.pinned === true) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .map(m => ({ ...m, ttlLeftMs: lifecycle.remainingMs(m) }));
    const tiers = { profile: profile.filter(m => m.status === 'active').length, durable: 0, episodic: 0, scratch: 0 };
    for (const w of state.workspaces) {
      const st = memory.stats(w);
      tiers.durable += st.tiers?.durable ?? 0;
      tiers.episodic += st.tiers?.episodic ?? 0;
      tiers.scratch += st.tiers?.scratch ?? 0;
    }
    const expired = state.workspaces.reduce((n, w) => n + (w.memories ?? []).filter(m => m.status === 'expired').length, 0) +
      (state.profile ?? []).filter(m => m.status === 'expired').length;
    const sessionEntries = Object.entries(state.sessions).sort((a, b) => {
      const at = s => Math.max(Number(s.routedAt) || 0, ...(s.recent ?? []).map(r => Number(r.at) || 0));
      return at(b[1]) - at(a[1]);
    });
    const sessions = await Promise.all(sessionEntries.slice(0, 12).map(async ([sessionId, s]) => ({
      sessionId, workspaceId: s.workspaceId, lastAt: s.routedAt, lastQuery: clipped(s.lastQuery, 80),
      activeWorkspaceIds: s.activeWorkspaceIds ?? [], lastSegments: s.lastSegments ?? [], multiQuery: clipped(s.multiQuery ?? '', 80),
      cost: await costOf(sessionId),
    })));
    const costRows = sessions.filter(s => s.cost?.found);
    const cost = {
      available: Boolean(costMeter) && costRows.length > 0,
      total: costRows.reduce((acc, s) => {
        acc.cost += s.cost.cost; acc.tokens += s.cost.tokens; acc.calls += s.cost.calls;
        return acc;
      }, { cost: 0, tokens: 0, calls: 0 }),
    };
    const inbox = (state.inbox ?? []).slice(-80).map(t => ({
      ...t,
      workspaceName: t.workspaceId ? (byId(t.workspaceId)?.name ?? t.workspaceName ?? '') : '',
    }));
    return {
      workspaces,
      profile,
      sessions,
      cost,
      archives: archiveSummaries ? state.archives.map(a => ({
        id: a.id,
        name: a.name,
        description: a.description,
        archivedAt: a.archivedAt,
        reason: a.reason,
        restorable: a.restorable,
        migratedTo: a.migratedTo,
        contextChars: a.contextChars,
        turnCount: (a.turns ?? []).length,
      })) : state.archives,
      inbox,
      inboxConfig: inboxStatus(),
      saveError: lastSaveError ? { ...lastSaveError } : null,
      governance: governance.report({ workspaces: state.workspaces, sessions: state.sessions, cfg, now: Date.now() }),
      trace: traces.slice(-30),
      stats: {
        workspaces: state.workspaces.length,
        memories: state.workspaces.reduce((n, w) => n + (w.memories ?? []).filter(m => m.status === 'active').length, 0),
        profile: profile.filter(m => m.status === 'active').length,
        expired,
        tiers,
        sessions: Object.values(state.sessions).filter(s => s.workspaceId).length,
        llmCalls: state.llmCalls ?? 0,
        contextChars: workspaces.reduce((n, w) => n + (w.contextChars ?? 0), 0),
        contextTokens: workspaces.reduce((n, w) => n + (w.contextTokens ?? 0), 0),
        contextMaxChars: cfg.contextMaxChars,
        multiTurns: state.multiTurns ?? 0,
        contextBreakdown: workspaces.reduce((acc, w) => {
          const b = w.contextBreakdown ?? {};
          for (const k of ['header', 'global', 'memories', 'open', 'recent', 'rules']) acc[k] += b[k] ?? 0;
          acc.total += b.total ?? 0;
          return acc;
        }, { header: 0, global: 0, memories: 0, open: 0, recent: 0, rules: 0, total: 0 }),
      },
    };
  }

  function resolveWs (token) {
    const t = String(token ?? '').trim();
    if (!t) return null;
    return byId(t) || state.workspaces.find(w => w.name === t) || state.workspaces.find(w => w.name.toLowerCase() === t.toLowerCase()) ||
      state.workspaces.find(w => w.name.includes(t)) || state.workspaces.find(w => w.id.includes(t));
  }

  function findMemory (id) {
    const key = String(id ?? '');
    if (!key) return null;
    for (const ws of state.workspaces) {
      const memory = (ws.memories ?? []).find(m => String(m.id) === key);
      if (memory) return { memory, list: ws.memories, ws };
    }
    const memory = (state.profile ?? []).find(m => String(m.id) === key);
    if (memory) return { memory, list: state.profile, ws: null };
    return null;
  }

  // cost-meter 是可选服务：只有宿主注入了才显示费用，没装/未启用时面板完全隐藏。
  async function costOf (sid) {
    if (!costMeter || typeof costMeter.getSessionCost !== 'function') return null;
    let timer = null;
    try {
      const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), 900); timer.unref?.(); });
      const out = await Promise.race([costMeter.getSessionCost(sid), timeout]);
      const own = out?.own;
      if (!out?.found || !own) return { found: false };
      const tokens = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']
        .reduce((n, k) => n + (Number(own[k]) || 0), 0);
      return { found: true, cost: Number(own.cost) || 0, apiCost: Number(own.apiCost) || 0, calls: Number(own.calls) || 0, tokens };
    } catch { return null; } finally { if (timer) clearTimeout(timer); }
  }

  async function runMigration (payload) {
    const into = resolveWs(payload?.into);
    if (!into) return { error: '目标工作区不存在：' + String(payload?.into ?? '') };
    const rawIds = Array.isArray(payload?.sourceIds) ? payload.sourceIds : [payload?.id];
    const found = [...new Set(rawIds.map(x => String(x ?? '').trim()).filter(Boolean))]
      .map(id => resolveWs(id)).filter(Boolean);
    if (!found.length) return { error: '来源工作区不存在' };
    if (found.some(s => s.id === into.id)) return { error: '来源工作区不能是目标工作区' };
    // 同一个区可能既传 id 又传名字；按 resolve 后的 id 去重，避免重复 plan/扣轮次。
    const sources = [...new Map(found.map(s => [s.id, s])).values()];

    const query = clipped(payload?.query ?? '', 240);
    const mode = payload?.mode === 'all' ? 'all' : 'match';
    if (mode === 'match' && !query) return { error: '按关键词迁移时必须填写关键词；要全部迁移请把 mode 设为 all' };
    const rawMin = Number(payload?.minScore);
    const minScore = Number.isFinite(rawMin) ? Math.max(0, Math.min(1, rawMin)) : migrate.MIGRATE_DEFAULTS.minScore;
    const dryRun = payload?.dryRun !== false;
    const archiveMode = ['auto', 'always', 'never'].includes(payload?.archiveMode) ? payload.archiveMode : 'auto';
    const exclude = Array.isArray(payload?.exclude) ? payload.exclude.map(String).slice(0, 600) : [];
    const include = Array.isArray(payload?.include) ? payload.include.map(String).slice(0, 600) : [];
    const plans = sources.map(source => {
      const plan = migrate.planMigration(source, { query, mode, minScore, include, roundContext: payload?.roundContext !== false });
      if (exclude.length) migrate.applyExclusions(plan, exclude);
      return { source, plan };
    });
    const totals = plans.reduce((acc, x) => {
      acc.turns += x.plan.turns.length;
      acc.memories += x.plan.memories.length;
      acc.remainingTurns += x.plan.remainingTurns;
      acc.remainingMemories += x.plan.remainingMemories;
      acc.near += x.plan.nearItems?.length ?? 0;
      return acc;
    }, { turns: 0, memories: 0, remainingTurns: 0, remainingMemories: 0, near: 0 });

    if (dryRun) {
      return {
        ok: true, dryRun: true, mode, query, minScore, archiveMode,
        target: { id: into.id, name: into.name },
        plans: plans.map(x => migrate.previewOf(x.plan, x.source, into)),
        totals,
      };
    }

    const lockedWorkspaces = [...new Set([into.id, ...sources.map(source => source.id)])]
      .map(id => ({ id, error: inboxLockError(id) })).filter(x => x.error);
    if (lockedWorkspaces.length) {
      return { error: '迁移涉及有排队或运行任务的工作区，请先处理收件箱任务。', blocked: lockedWorkspaces };
    }

    const now = Date.now();
    let movedTurns = 0;
    let movedMemories = 0;
    const archived = [];
    const kept = [];
    for (const { source, plan } of plans) {
      if (!plan.turns.length && !plan.memories.length) {
        kept.push({ id: source.id, name: source.name, reason: 'no-match', remainingTurns: plan.remainingTurns, remainingMemories: plan.remainingMemories });
        continue;
      }
      const moved = migrate.applyPlan(source, into, plan, { now });
      movedTurns += moved.turns;
      movedMemories += moved.memories;
      if (archiveMode === 'always' || (archiveMode === 'auto' && moved.empty)) {
        archived.push(archiveMigrated(source, into, moved));
      } else {
        source.updatedAt = now;
        kept.push({ id: source.id, name: source.name, remainingTurns: moved.remainingTurns, remainingMemories: moved.remainingMemories });
      }
    }
    if (payload?.rebindSessions !== false) rebindSessions(sources.map(s => s.id), into);
    into.updatedAt = now;
    log('migrate ' + sources.map(s => s.id).join(',') + ' -> ' + into.id + ' turns=' + movedTurns + ' memories=' + movedMemories + ' archived=' + archived.length);
    touch(); await flush();
    return {
      ok: true, dryRun: false, mode, query,
      target: { id: into.id, name: into.name },
      moved: { turns: movedTurns, memories: movedMemories },
      archived, kept,
      totals,
    };
  }

  async function applyOp (payload) {
    await ensureLoaded();
    const op = String(payload?.op ?? '');
    if (op === 'export') {
      const list = payload?.all === true
        ? state.workspaces.slice()
        : (Array.isArray(payload?.ids) ? payload.ids : [payload?.id]).map(resolveWs).filter(Boolean);
      if (!list.length) return { error: '没有可导出的工作区' };
      const format = payload?.format === 'json' ? 'json' : 'markdown';
      const now = Date.now();
      const profile = payload?.withProfile === false ? [] : state.profile;
      const content = format === 'json'
        ? portable.toJson(list, { now, profile })
        : portable.toMarkdown(list, { now, profile });
      const base = list.length === 1 ? String(list[0].name || '工作区') : '工作区导出';
      const safe = clipped(base, 60).replace(/[\\/:*?"<>|\s]+/gu, '-').replace(/^-+|-+$/gu, '') || 'workspace';
      return {
        ok: true, format, count: list.length, profile: (profile ?? []).length,
        filename: safe + (format === 'json' ? '.json' : '.md'),
        content,
      };
    }
    if (op === 'import') {
      const raw = String(payload?.content ?? '');
      if (!raw.trim()) return { error: '导入内容为空' };
      if (raw.length > 8 * 1024 * 1024) return { error: '导入内容超过 8MB，请拆分后再试' };
      const now = Date.now();
      const parsed = portable.parsePortable(raw, { now, salt: 'import|' + now + '|' + Math.random() });
      if (parsed.error) return { error: parsed.error };
      // 导入前先查容量：createWorkspace 满额会归档最老区，导入大文件会把现有工作区静默移走。
      const capacity = Number(cfg.maxWorkspaces) || 60;
      if (state.workspaces.length + parsed.workspaces.length > capacity) {
        return {
          error: '工作区数量会超过上限：现有 ' + state.workspaces.length + ' 个，导入 ' +
            parsed.workspaces.length + ' 个，上限 ' + capacity + ' 个。请先归档部分工作区再导入。',
        };
      }
      // 导入是事务：中途失败（满额、异常）就恢复导入前的完整状态，避免留下半套数据。
      const backup = structuredClone(state);
      const imported = [];
      let importedProfile = 0;
      try {
        for (const item of parsed.workspaces) {
          let name = clipped(item.name, 60) || '导入的工作区';
          if (state.workspaces.some(w => w.name === name)) {
            const root = clipped(name, 48);
            let n = 2;
            while (state.workspaces.some(w => w.name === name)) { name = root + '（导入 ' + n + '）'; n++; }
          }
          const ws = createWorkspace(name + ' ' + (item.description ?? ''), name);
          if (!ws) throw new Error('工作区已达上限，且所有候选归档区都有排队或运行中的收件箱任务');
          ws.name = name;
          ws.description = item.description ?? '';
          ws.keywords = item.keywords ?? ws.keywords;
          ws.summary = item.summary ?? '';
          ws.rounds = Number(item.rounds) || 0;
          ws.turns = item.turns ?? [];
          ws.memories = (item.memories ?? []).map(m => ({ ...m, scope: 'workspace' }));
          ws.exemplars = item.exemplars ?? [];
          ws.policy = policy.normalizePolicy(item.policy ?? {});
          ws.hits = Number(item.hits) || 0;
          ws.createdAt = Number(item.createdAt) || ws.createdAt;
          ws.updatedAt = Number(item.updatedAt) || Date.now();
          imported.push({ id: ws.id, name: ws.name, turns: ws.turns.length, memories: ws.memories.length });
        }
        const seen = new Set((state.profile ?? []).map(m => String(m.text ?? '').replace(/\s+/gu, ' ').trim()));
        for (const m of parsed.profile ?? []) {
          const key = String(m.text ?? '').replace(/\s+/gu, ' ').trim();
          if (!key || seen.has(key)) continue;
          seen.add(key);
          state.profile.push(m);
          importedProfile++;
        }
      } catch (error) {
        state = backup;
        log('import rolled back: ' + String(error?.message ?? error));
        return { error: '导入失败，已回滚：' + String(error?.message ?? error) };
      }
      log('import ' + imported.length + ' workspaces, ' + importedProfile + ' profile memories');
      touch(); await flush();
      return { ok: true, imported, importedProfile };
    }
    if (op === 'create') {
      const name = clipped(payload?.name, 60);
      if (!name) return { error: '名称不能为空' };
      const exists = state.workspaces.find(w => w.name === name);
      if (exists) return { error: '同名工作区已存在：' + exists.id };
      const ws = createWorkspace(name + ' ' + clipped(payload?.description, 300), name);
      if (!ws) return { error: '工作区已达上限，且所有候选归档区都有排队或运行中的收件箱任务。请先处理收件箱任务。' };
      ws.name = name;
      ws.description = clipped(payload?.description, 300);
      ws.policy = policy.normalizePolicy(payload?.policy ?? {});
      log('create ws ' + ws.id + ' (' + ws.name + ')');
      touch(); await flush();
      return { ok: true, id: ws.id, name: ws.name };
    }
    if (op === 'migrate') return await runMigration(payload);
    if (op === 'restore') {
      const entry = state.archives.find(a => a.id === String(payload?.id ?? ''));
      if (!entry) return { error: '归档不存在：' + String(payload?.id ?? '') };
      if (entry.restorable === false) {
        return { error: '这条归档来自上下文迁移，原文已搬到「' + (entry.migratedTo?.name ?? '目标工作区') + '」，不能原地恢复' };
      }
      if (state.workspaces.length >= (Number(cfg.maxWorkspaces) || 60)) {
        return { error: '工作区已达上限 ' + (Number(cfg.maxWorkspaces) || 60) + ' 个，请先归档或删除一个再恢复。' };
      }
      const ws = createWorkspace(entry.name + ' ' + (entry.description ?? ''), entry.name);
      if (!ws) return { error: '工作区已达上限，且所有候选归档区都有排队或运行中的收件箱任务。请先处理收件箱任务。' };
      ws.description = entry.description ?? '';
      ws.keywords = entry.keywords ?? ws.keywords;
      ws.summary = entry.summary ?? '';
      ws.turns = (entry.turns ?? []).map(t => ({ ...t }));
      // 保留 superseded/expired/archived 状态；恢复归档不等于复活已被替代的旧结论。
      ws.memories = (entry.memories ?? []).map(m => lifecycle.normalizeMemory(m, { now: Date.now() }));
      ws.rounds = entry.rounds ?? 0;
      ws.policy = policy.normalizePolicy(entry.policy ?? {});
      ws.exemplars = (entry.exemplars ?? []).map(e => ({ ...e }));
      ws.hits = Number(entry.hits) || 0;
      ws.createdAt = Number(entry.createdAt) || ws.createdAt;
      ws.updatedAt = Date.now();
      state.archives = state.archives.filter(a => a !== entry);
      log('restore ws ' + entry.id + ' -> ' + ws.id);
      touch(); await flush();
      return { ok: true, id: ws.id };
    }
    if (op === 'dropArchive') {
      const before = state.archives.length;
      state.archives = state.archives.filter(a => a.id !== String(payload?.id ?? ''));
      if (state.archives.length === before) return { error: '归档不存在：' + String(payload?.id ?? '') };
      log('drop archive ' + String(payload?.id ?? ''));
      touch(); await flush();
      return { ok: true };
    }
    if (op === 'openShell') {
      const out = shellOs.launchShell({ url: String(payload?.url ?? ''), appPath: shellAppPath });
      return out.ok ? { ok: true, launched: true } : { error: out.error };
    }
    if (op === 'sweep') {
      const expired = sweepState(Date.now(), true);
      await flush();
      return { ok: true, expired };
    }
    if (op === 'governanceApply') {
      const ids = [...new Set((Array.isArray(payload?.ids) ? payload.ids : []).map(String))].filter(Boolean);
      if (!ids.length) return { error: '没有选择要归档的工作区' };
      const archived = [];
      const skipped = [];
      for (const id of ids) {
        const target = byId(id);
        if (!target) { skipped.push({ id, reason: '工作区不存在' }); continue; }
        if (hasPendingInboxTasks(id)) {
          skipped.push({ id, reason: '该区有收件箱任务排队中或正在运行' });
          continue;
        }
        archiveWorkspace(target, 'governance');
        archived.push({ id, name: target.name });
      }
      if (!archived.length) return { error: '没有可归档的工作区', skipped };
      await flush();
      return { ok: true, archived, skipped };
    }
    if (op === 'inboxAdd') {
      const text = clipped(payload?.text, 4000).trim();
      if (!text) return { error: '任务内容不能为空' };
      const ws = payload?.workspaceId ? byId(String(payload.workspaceId)) : null;
      if (!ws) return { error: '请先选择一个工作区（手动锁定）' };
      if (!Array.isArray(state.inbox)) state.inbox = [];
      const now = Date.now();
      const task = {
        id: 'q_' + hash(text + '|' + now + '|' + Math.random(), 10),
        text, workspaceId: ws.id, workspaceName: ws.name, status: 'queued',
        error: '', result: '', simulated: false, executor: '', childSessionId: '', parentSessionId: '', cwd: '',
        createdAt: now, startedAt: 0, finishedAt: 0,
      };
      state.inbox.push(task);
      trimInbox();
      log('inbox add ' + task.id + ' ws=' + ws.id);
      touch(); await flush();
      return { ok: true, task };
    }
    if (op === 'inboxRun') return await advanceInbox(payload?.all === true);
    if (op === 'inboxCancel') {
      const task = (state.inbox ?? []).find(t => t.id === String(payload?.id ?? ''));
      if (!task) return { error: '任务不存在：' + String(payload?.id ?? '') };
      if (task.status !== 'queued' && task.status !== 'running') return { error: '只能取消排队中或运行中的任务' };
      if (task.status === 'running') {
        const run = inboxRuns.get(task.id);
        if (run) run.controller.abort();
      }
      task.status = 'cancelled';
      task.finishedAt = Date.now();
      task.error = '用户取消';
      log('inbox cancel ' + task.id);
      touch(); await flush();
      return { ok: true, task };
    }
    if (op === 'inboxRetry') {
      const task = (state.inbox ?? []).find(t => t.id === String(payload?.id ?? ''));
      if (!task) return { error: '任务不存在：' + String(payload?.id ?? '') };
      if (task.status !== 'failed' && task.status !== 'cancelled') return { error: '只能重试失败或已取消的任务' };
      task.status = 'queued';
      task.error = '';
      task.result = '';
      task.simulated = false;
      task.executor = '';
      task.childSessionId = '';
      task.parentSessionId = '';
      task.cwd = '';
      task.startedAt = 0;
      task.finishedAt = 0;
      log('inbox retry ' + task.id);
      touch(); await flush();
      return { ok: true, task };
    }
    if (op === 'inboxRemove') {
      const id = String(payload?.id ?? '');
      const task = (state.inbox ?? []).find(t => t.id === id);
      if (!task) return { error: '任务不存在：' + id };
      if (task.status === 'running') return { error: '运行中的任务不能直接删除，请先取消' };
      state.inbox = (state.inbox ?? []).filter(t => t.id !== id);
      log('inbox remove ' + id);
      touch(); await flush();
      return { ok: true };
    }
    if (op === 'inboxClear') {
      const all = payload?.all === true;
      const before = (state.inbox ?? []).length;
      if (all) {
        for (const run of inboxRuns.values()) run.controller.abort();
        inboxAll = false;
        if (inboxNext) { clearTimeout(inboxNext); inboxNext = null; }
        state.inbox = [];
      } else {
        state.inbox = (state.inbox ?? []).filter(t => t.status === 'queued' || t.status === 'running');
      }
      log('inbox clear' + (all ? ' all' : ' finished'));
      touch(); await flush();
      return { ok: true, removed: before - (state.inbox ?? []).length };
    }
    if (op === 'pin' || op === 'restoreMemory') {
      const found = findMemory(payload?.id);
      if (!found) return { error: '记忆不存在：' + String(payload?.id ?? '') };
      if (found.memory.status === 'superseded') {
        return { error: '这条记忆已被更新结论替代，不能置顶或恢复；请查看新结论' };
      }
      const updated = op === 'pin'
        ? lifecycle.pinMemory(found.list, payload.id, payload?.pinned === false ? false : true, Date.now())
        : lifecycle.restoreMemory(found.list, payload.id, Date.now());
      if (!updated) return { error: '记忆不存在：' + String(payload?.id ?? '') };
      log(op + ' memory ' + updated.id + (found.ws ? ' ws=' + found.ws.id : ' global'));
      touch(); await flush();
      return { ok: true, memory: { ...updated, ttlLeftMs: lifecycle.remainingMs(updated) } };
    }
    if (op === 'list') return { ok: true, ...(await snapshot()) };
    const ws = payload?.id ? byId(String(payload.id)) : null;
    if (!ws) return { error: '工作区不存在：' + String(payload?.id ?? '') };
    if (['archive', 'clear', 'delete', 'merge'].includes(op)) {
      const lock = inboxLockError(ws.id);
      if (lock) return { error: lock };
    }
    if (op === 'policy') {
      ws.policy = policy.normalizePolicy(payload?.policy && typeof payload.policy === 'object' ? payload.policy : payload);
      log('policy ' + ws.id + ' -> ' + JSON.stringify(ws.policy));
      touch(); await flush();
      return { ok: true, policy: ws.policy };
    }
    if (op === 'archive') {
      const freed = archiveWorkspace(ws, 'manual');
      await flush();
      return { ok: true, archived: true, freed };
    }
    if (op === 'rename') {
      const next = clipped(payload.name, 60);
      if (!next) return { error: '名称不能为空' };
      log('rename ' + ws.id + ': ' + ws.name + ' -> ' + next);
      ws.name = next;
    } else if (op === 'describe') {
      ws.description = clipped(payload.description, 300);
      log('describe ' + ws.id + ' -> ' + ws.description);
    } else if (op === 'clear') {
      ws.turns = []; ws.memories = []; ws.summary = ''; ws.rounds = 0; ws.exemplars = [];
      log('clear ' + ws.id);
    } else if (op === 'delete') {
      const freed = usageOf(ws);
      state.workspaces = state.workspaces.filter(w => w.id !== ws.id);
      state.archives = state.archives.filter(a => a.id !== ws.id);
      unbindWorkspace(ws.id);
      log('delete ws ' + ws.id + ' (' + ws.name + ') freed=' + freed.chars + ' chars');
      touch(); await flush();
      return { ok: true, freed };
    } else if (op === 'merge') {
      const into = resolveWs(payload.into);
      if (!into) return { error: '目标工作区不存在：' + String(payload.into ?? '') };
      if (into.id === ws.id) return { error: '不能合并到自己' };
      const targetLock = inboxLockError(into.id);
      if (targetLock) return { error: '合并目标' + targetLock };
      router.mergeWorkspace(ws, into);
      rebindSessions([ws.id], into);
      // 合并不可逆：先把来源完整归档（含全量对话/记忆），用户仍可在归档区找回。
      archiveWorkspace(ws, 'merged');
      log('merge ' + ws.id + ' -> ' + into.id + ' (source archived)');
      await flush();
      return { ok: true, mergedIntoTarget: into.id, archived: true };
    } else {
      return { error: '未知操作：' + op };
    }
    ws.updatedAt = Date.now();
    touch(); await flush();
    return { ok: true };
  }

  /* ── 钩子 ── */

  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      await ensureLoaded();
      sweepState();
      const agent = payload?.agent;
      const text = lastUserText(payload?.messages);
      if (!text) return next();
      const sid = agent?.session?.id ?? 'unknown';
      if (cfg.ignoreSubagents !== false && isSubagent(agent, text)) {
        if (!subagentLogged.has(sid)) { subagentLogged.add(sid); log('skip subagent session ' + sid); }
        return next();
      }
      const turn = payload?.turn ?? 0;
      const key = sid + ':' + turn + ':' + hash(text, 8);
      if (seenSteps.has(key)) return next();
      seenSteps.add(key);
      if (seenSteps.size > 2000) seenSteps.delete(seenSteps.values().next().value);
      await routeMessage(agent, text, turn, payload?.signal);
    } catch (error) {
      log('pre-step fail: ' + String(error?.message ?? error));
    }
    return next();
  });

  ctx.on('session/event', (session, event) => {
    void ensureLoaded().then(() => onAssistant(session, event)).catch(error => log('assistant fail: ' + String(error?.message ?? error)));
  });

  // 系统提示词：随当前绑定工作区与最后一条用户消息动态变化，原地替换。
  let order = cfg.sectionOrder;
  try {
    const resolved = ctx.systemPrompt.getSectionOrder?.('HYBRID_WORKSPACE');
    if (typeof resolved === 'number') order = resolved;
  } catch { /* 未注册：用数字顺序 */ }

  ctx.systemPrompt.section({
    name: 'hybrid-workspace',
    order,
    interpolate: false,
    text: (contextObj) => {
      const sid = contextObj?.agent?.session?.id;
      if (!sid || !loaded) return '';
      const s = state.sessions[sid];
      sweepState();
      const baseCfg = {
        contextMaxChars: cfg.contextMaxChars,
        memoryInject: cfg.memoryInject,
        profileInject: cfg.profileInject,
        recentTurns: cfg.recentTurns,
      };
      if (Array.isArray(s?.lastSegments) && s.lastSegments.length > 1 && s.multiQuery) {
        // 只保留仍存在的工作区，segments 与 workspaces 必须一一对齐。
        const pairs = s.lastSegments.map(seg => ({ seg, ws: byId(seg.wsId) })).filter(p => p.ws);
        const list = pairs.map(p => p.ws);
        if (list.length > 1) {
          return context.buildMultiContext(list, pairs.map(p => p.seg), {
            ...baseCfg,
            multiContextMaxChars: cfg.multiContextMaxChars,
          }, Date.now(), state.profile);
        }
      }
      const ws = s?.workspaceId ? byId(s.workspaceId) : null;
      if (!ws) return '';
      return context.buildContext(ws, s.lastQuery ?? '', baseCfg, Date.now(), state.profile);
    },
  });

  /* ── cost-meter 是可选服务：注入了就桥接费用，没有就保持隐藏 ── */
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['costMeter'], (scoped) => {
        const service = scoped.costMeter;
        costMeter = service;
        scoped.effect(() => () => { if (costMeter === service) costMeter = null; });
        log('cost-meter bridged');
      });
    } catch (error) {
      log('cost-meter bridge fail: ' + String(error?.message ?? error));
    }
  }

  /* ── 面板：webServer 是可选服务，必须靠 inject 等待，不能直接读 ctx.webServer ── */
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (scoped) => {
        scoped.effect(() => mountRoutes(scoped, {
          prefix: cfg.panelPath,
          snapshot: async (options) => { await ensureLoaded(); return snapshot(options); },
          mutate: async (payload) => { await ensureLoaded(); return applyOp(payload); },
        }));
        log('panel mounted at ' + cfg.panelPath + '/');
      });
    } catch (error) {
      log('panel mount fail: ' + String(error?.message ?? error));
    }
  }

  ctx.on('dispose', async () => {
    try { await flush(); } catch (error) { log('dispose flush fail: ' + String(error?.message ?? error)); }
  });
  if (!cfg.disableProcessHook) {
    process.once('beforeExit', () => { void flush().catch(error => log('exit flush fail: ' + String(error?.message ?? error))); });
  }

  void ensureLoaded().catch(error => log('load fail: ' + String(error?.message ?? error)));

  return {
    // 测试/调试入口：只读快照与手动 flush，不暴露可变状态。
    snapshot,
    flush,
    get state () { return state; },
  };
}
