// 上下文迁移：按关键词从来源工作区挑出对话/记忆，搬到目标工作区。
// 纯函数、零 DSH import；索引层只负责校验、归档与重绑会话。

import { clipped, hash, tokens } from './text.js';

export const MIGRATE_DEFAULTS = Object.freeze({
  minScore: 0.34,
  maxSample: 3,
});

const norm = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();
const roundOf = (t) => Number(t?.turn) || Number(t?.round) || 0;
// 预览 key 会进 HTML data-key；用稳定 hash，避免 NUL 被浏览器替换成 U+FFFD 导致排除/补选失效。
const turnKey = (t) => 't_' + hash([t?.role ?? '', t?.text ?? '', t?.at ?? ''].join('|'), 16);
const memoryText = (m) => [m?.text ?? '', ...(m?.keys ?? [])].join(' ');
const memoryKey = (m) => (m?.id ? 'id:' + m.id : 'txt:' + norm(m?.text));
const scoreOf = (map, item) => Math.round((map.get(item) ?? 0) * 1000) / 1000;

function buildIdf (docs) {
  const df = new Map();
  for (const text of docs) {
    for (const token of tokens(text)) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const n = Math.max(1, docs.length);
  const idf = new Map();
  for (const [token, d] of df) idf.set(token, Math.log(1 + n / (1 + d)));
  return { idf, n };
}

function scoreText (queryTokens, text, idf, total, unseen) {
  if (!queryTokens.length || !total) return 0;
  const set = tokens(text);
  let hit = 0;
  for (const token of queryTokens) {
    if (set.has(token)) hit += idf.get(token) ?? unseen;
  }
  return Math.min(1, hit / total);
}

function movableMemory (m) {
  if (!m || typeof m.text !== 'string' || !m.text.trim()) return false;
  // superseded / archived 是历史垃圾，不参与迁移；expired 仍搬走，保留生命周期状态。
  return m.status !== 'superseded' && m.status !== 'archived';
}

/**
 * 计算迁移方案，不修改来源/目标。
 * mode='match' 按 query 打分；mode='all' 全搬。
 * 命中一条对话时默认带上同一轮的助手回答（roundContext）。
 */
export function planMigration (source, options = {}) {
  const mode = options.mode === 'all' ? 'all' : 'match';
  const rawMin = Number(options.minScore);
  const minScore = Number.isFinite(rawMin) ? Math.max(0, Math.min(1, rawMin)) : MIGRATE_DEFAULTS.minScore;
  const nearFloor = Math.min(minScore, Math.max(0.08, minScore - 0.26));
  const roundContext = options.roundContext !== false;
  const maxSample = Math.max(1, Number(options.maxSample) || MIGRATE_DEFAULTS.maxSample);
  const query = clipped(options.query ?? '', 240);

  const turns = Array.isArray(source?.turns) ? source.turns.filter(t => t && typeof t.text === 'string') : [];
  const memories = (Array.isArray(source?.memories) ? source.memories : []).filter(movableMemory);
  const exemplars = Array.isArray(source?.exemplars) ? source.exemplars : [];
  const include = new Set((Array.isArray(options.include) ? options.include : []).map(String));
  const queryTokens = [...tokens(query)];
  const { idf, n } = buildIdf([
    ...turns.map(t => t.text),
    ...memories.map(memoryText),
    ...exemplars.map(e => e?.text ?? e),
  ]);
  const unseen = Math.log(1 + n);
  const total = queryTokens.reduce((sum, token) => sum + (idf.get(token) ?? unseen), 0);
  const score = (text) => mode === 'all' ? 1 : scoreText(queryTokens, text, idf, total, unseen);

  const scoredTurns = turns.map(t => ({ t, score: score(t.text) }));
  const pickedTurns = new Set();
  if (mode === 'all') for (const t of turns) pickedTurns.add(t);
  else for (const x of scoredTurns) if (x.score >= minScore) pickedTurns.add(x.t);
  if (mode === 'match' && include.size) for (const t of turns) if (include.has(turnKey(t))) pickedTurns.add(t);

  if (mode === 'match' && roundContext && pickedTurns.size) {
    const rounds = new Set([...pickedTurns].map(roundOf).filter(Boolean));
    if (rounds.size) {
      for (const t of turns) {
        if (pickedTurns.has(t)) continue;
        if (rounds.has(roundOf(t))) pickedTurns.add(t);
      }
    }
  }

  const scoredMemories = memories.map(m => ({ m, score: score(memoryText(m)) }));
  const pickedMemories = new Set();
  if (mode === 'all') for (const m of memories) pickedMemories.add(m);
  else for (const x of scoredMemories) if (x.score >= minScore) pickedMemories.add(x.m);
  if (mode === 'match' && include.size) for (const m of memories) if (include.has(memoryKey(m))) pickedMemories.add(m);

  const pickedExemplars = mode === 'all' ? exemplars.slice() : exemplars.filter(e => score(e?.text ?? e) >= minScore);
  const turnList = turns.filter(t => pickedTurns.has(t));
  const memoryList = memories.filter(m => pickedMemories.has(m));
  const turnScores = new Map(scoredTurns.map(x => [x.t, x.score]));
  const memoryScores = new Map(scoredMemories.map(x => [x.m, x.score]));
  const items = [
    ...turnList.map(t => ({
      kind: 'turn', key: turnKey(t), role: t.role === 'assistant' ? 'assistant' : 'user',
      round: roundOf(t), at: Number(t.at) || 0, text: clipped(t.text, 140), score: scoreOf(turnScores, t),
    })),
    ...memoryList.map(m => ({
      kind: 'memory', key: memoryKey(m), role: 'memory',
      round: Number(m.turn) || 0, at: Number(m.at) || 0, text: clipped(m.text, 140), score: scoreOf(memoryScores, m),
    })),
  ].sort((a, b) => (a.round - b.round) || (a.kind === b.kind ? 0 : a.kind === 'turn' ? -1 : 1));
  const nearItems = mode === 'all' ? [] : [
    ...scoredTurns.filter(x => !pickedTurns.has(x.t) && x.score >= nearFloor && x.score < minScore)
      .map(x => ({ kind: 'turn', key: turnKey(x.t), role: x.t.role === 'assistant' ? 'assistant' : 'user', round: roundOf(x.t), at: Number(x.t.at) || 0, text: clipped(x.t.text, 140), score: Number(x.score.toFixed(3)) })),
    ...scoredMemories.filter(x => !pickedMemories.has(x.m) && x.score >= nearFloor && x.score < minScore)
      .map(x => ({ kind: 'memory', key: memoryKey(x.m), role: 'memory', round: Number(x.m.turn) || 0, at: Number(x.m.at) || 0, text: clipped(x.m.text, 140), score: Number(x.score.toFixed(3)) })),
  ].sort((a, b) => b.score - a.score).slice(0, 40);
  const top = [
    ...scoredTurns.filter(x => x.score > 0).sort((a, b) => b.score - a.score)
      .slice(0, maxSample).map(x => ({ kind: 'turn', score: Number(x.score.toFixed(3)), text: clipped(x.t.text, 80) })),
    ...scoredMemories.filter(x => x.score > 0).sort((a, b) => b.score - a.score)
      .slice(0, maxSample).map(x => ({ kind: 'memory', score: Number(x.score.toFixed(3)), text: clipped(x.m.text, 80) })),
  ];

  return {
    mode,
    query,
    minScore,
    turns: turnList,
    memories: memoryList,
    exemplars: pickedExemplars,
    totalTurns: turns.length,
    totalMemories: memories.length,
    remainingTurns: turns.length - turnList.length,
    remainingMemories: memories.length - memoryList.length,
    summary: mode === 'all' ? String(source?.summary ?? '') : '',
    scores: top,
    items,
    nearItems,
    sample: turnList.slice(0, maxSample).map(t => clipped(t.text, 80)),
    memorySample: memoryList.slice(0, maxSample).map(m => clipped(m.text, 80)),
  };
}

/** 预览里取消勾选的条目按 key 排除；排除后重新计算剩余量，不修改来源。 */
export function applyExclusions (plan, exclude) {
  const keys = new Set((Array.isArray(exclude) ? exclude : []).map(String));
  if (!keys.size) return plan;
  plan.turns = (plan.turns ?? []).filter(t => !keys.has(turnKey(t)));
  plan.memories = (plan.memories ?? []).filter(m => !keys.has(memoryKey(m)));
  plan.items = (plan.items ?? []).filter(i => !keys.has(i.key));
  plan.nearItems = (plan.nearItems ?? []).filter(i => !keys.has(i.key));
  plan.remainingTurns = Math.max(0, plan.totalTurns - plan.turns.length);
  plan.remainingMemories = Math.max(0, plan.totalMemories - plan.memories.length);
  plan.sample = plan.turns.slice(0, MIGRATE_DEFAULTS.maxSample).map(t => clipped(t.text, 80));
  plan.memorySample = plan.memories.slice(0, MIGRATE_DEFAULTS.maxSample).map(m => clipped(m.text, 80));
  return plan;
}

/** 只保留预览需要的字段，避免 API 把整段对话吐回来。 */
export function previewOf (plan, source, target) {
  return {
    source: { id: source.id, name: source.name },
    target: target ? { id: target.id, name: target.name } : null,
    mode: plan.mode,
    query: plan.query,
    minScore: plan.minScore,
    turns: plan.turns.length,
    memories: plan.memories.length,
    remainingTurns: plan.remainingTurns,
    remainingMemories: plan.remainingMemories,
    totalTurns: plan.totalTurns,
    totalMemories: plan.totalMemories,
    willArchive: plan.turns.length + plan.memories.length > 0 && plan.remainingTurns + plan.remainingMemories === 0,
    items: plan.items ?? [],
    nearItems: plan.nearItems ?? [],
    sample: plan.sample,
    memorySample: plan.memorySample,
    scores: plan.scores,
  };
}

/**
 * 把方案真正搬到目标区：去重、轮次重编号、关键词/摘要/代表问法合并。
 * 返回实际搬走的数量（目标已有同内容时不会重复添加）。
 */
export function applyPlan (source, into, plan, options = {}) {
  const now = Number(options.now) || Date.now();
  if (!Array.isArray(into.turns)) into.turns = [];
  if (!Array.isArray(into.memories)) into.memories = [];
  if (!Array.isArray(into.exemplars)) into.exemplars = [];
  const seenTurns = new Set(into.turns.map(turnKey));
  const seenMemoryIds = new Set(into.memories.map(m => String(m.id ?? '')));
  const seenMemoryText = new Set(into.memories.map(m => norm(m.text)));

  const sourceRounds = [...new Set(plan.turns.map(roundOf).filter(Boolean))].sort((a, b) => a - b);
  // 目标已有轮次可能比 into.rounds 记录的多；以实际最大轮次（不是消息条数）为基准，避免跳号。
  const maxTurn = Math.max(0, ...(into.turns ?? []).map(t => Number(t.turn) || 0));
  const base = Math.max(Number(into.rounds) || 0, maxTurn);
  const roundMap = new Map(sourceRounds.map((r, i) => [r, base + i + 1]));

  let movedTurns = 0;
  const movedSourceTurns = new Set();
  const movedRounds = new Set();
  for (const turn of plan.turns) {
    const key = turnKey(turn);
    if (seenTurns.has(key)) continue;
    seenTurns.add(key);
    const mapped = roundMap.get(roundOf(turn)) ?? roundOf(turn);
    into.turns.push({ ...turn, turn: mapped, round: mapped });
    movedSourceTurns.add(turn);
    if (roundOf(turn)) movedRounds.add(roundOf(turn));
    movedTurns++;
  }

  let movedMemories = 0;
  const movedSourceMemories = new Set();
  for (const memory of plan.memories) {
    const text = norm(memory.text);
    const key = memoryKey(memory);
    if (seenMemoryIds.has(key.replace(/^id:/, '')) || seenMemoryText.has(text)) continue;
    let id = String(memory.id ?? ('m_' + hash(memory.text + now, 10)));
    if (seenMemoryIds.has(id)) id = 'm_' + hash(String(memory.text) + id + now, 10);
    const turn = roundMap.get(Number(memory.turn)) ?? 0;
    into.memories.push({ ...memory, id, turn });
    seenMemoryIds.add(id);
    seenMemoryText.add(text);
    movedSourceMemories.add(memory);
    movedMemories++;
  }

  // 只按“实际搬走”的轮次增加目标 rounds；目标已有同内容而跳过的，不虚增、也不从来源删除。
  into.rounds = base + movedRounds.size;
  into.updatedAt = now;
  if (Array.isArray(plan.exemplars) && plan.exemplars.length) {
    const seen = new Set(into.exemplars.map(e => norm(e?.text ?? e)));
    for (const e of plan.exemplars) {
      const text = clipped(e?.text ?? e, 200);
      if (!text || seen.has(norm(text))) continue;
      seen.add(norm(text));
      into.exemplars.push({ text, at: now });
    }
    into.exemplars = into.exemplars.slice(-16);
  }
  into.keywords = [...new Set([...(into.keywords ?? []), ...(source.keywords ?? [])])].slice(0, 12);

  if (plan.summary) {
    if (!into.summary) into.summary = plan.summary;
    else if (!into.summary.includes(plan.summary)) into.summary = clipped(into.summary + ' / ' + plan.summary, 700);
  }

  source.turns = (source.turns ?? []).filter(t => !movedSourceTurns.has(t));
  source.memories = (source.memories ?? []).filter(m => !movedSourceMemories.has(m));
  source.rounds = Math.max(0, (Number(source.rounds) || 0) - movedRounds.size);
  if (plan.summary && !source.turns.length && !source.memories.length) source.summary = '';

  return {
    turns: movedTurns,
    memories: movedMemories,
    rounds: movedRounds.size,
    skippedTurns: (plan.turns?.length ?? 0) - movedTurns,
    skippedMemories: (plan.memories?.length ?? 0) - movedMemories,
    empty: (source.turns?.length ?? 0) === 0 && (source.memories?.length ?? 0) === 0,
    remainingTurns: source.turns?.length ?? 0,
    remainingMemories: source.memories?.length ?? 0,
  };
}