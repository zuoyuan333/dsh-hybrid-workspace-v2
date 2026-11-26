// 工作区治理：只做只读诊断，归档由 index.js 执行，便于单测与 dry-run。
export const DAY = 24 * 3600 * 1000;

function ageOf (lastAt, now) {
  const age = Math.max(0, Number(now) - Number(lastAt || 0));
  return { ageMs: age, ageDays: Math.floor(age / DAY) };
}

function bindingsOf (workspaceId, sessions) {
  const list = Object.values(sessions ?? {}).filter(s => s && s.workspaceId === workspaceId);
  const times = [];
  for (const s of list) {
    times.push(Number(s.routedAt) || 0);
    for (const r of s.recent ?? []) times.push(Number(r?.at) || 0);
  }
  return { count: list.length, lastAt: Math.max(0, ...times) };
}

export function workspaceFacts (ws, sessions, now = Date.now()) {
  const bound = bindingsOf(ws.id, sessions);
  const lastActiveAt = Math.max(Number(ws.updatedAt) || 0, Number(ws.createdAt) || 0, bound.lastAt);
  return {
    id: ws.id,
    name: ws.name,
    rounds: Number(ws.rounds) || 0,
    turns: Array.isArray(ws.turns) ? ws.turns.length : 0,
    memories: Array.isArray(ws.memories) ? ws.memories.length : 0,
    sessions: bound.count,
    lastActiveAt,
    ...ageOf(lastActiveAt, now),
  };
}

function numberOr (value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// 返回三组：auto（可归档的空壳/长期不活跃）、review（需确认的低活跃/重复/超限）、duplicates。
export function report ({ workspaces = [], sessions = {}, cfg = {}, now = Date.now() } = {}) {
  const activeLimit = Math.max(1, Math.floor(numberOr(cfg.activeLimit, 12)));
  const emptyTtl = numberOr(cfg.governanceEmptyTtlMs, 7 * DAY);
  const staleMs = numberOr(cfg.governanceStaleMs, 30 * DAY);
  const lowRounds = Math.max(0, Math.floor(numberOr(cfg.governanceLowRounds, 2)));
  const facts = workspaces.map(ws => workspaceFacts(ws, sessions, now));

  const auto = [];
  const review = [];
  const seen = new Set();
  const add = (list, item) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    list.push(item);
  };

  for (const f of facts) {
    const idle = now - f.lastActiveAt;
    if (f.sessions === 0 && f.turns === 0 && f.memories === 0 && idle >= emptyTtl) {
      add(auto, { ...f, kind: 'auto', reason: 'empty-shell', label: '空壳工作区' });
    } else if (f.sessions === 0 && idle >= staleMs) {
      add(auto, { ...f, kind: 'auto', reason: 'stale', label: '长期不活跃' });
    } else if (f.sessions === 0 && f.rounds <= lowRounds) {
      add(review, { ...f, kind: 'review', reason: 'low-activity', label: '低活跃' });
    }
  }

  // 同名工作区只给建议，不自动合并：目标选轮次更多、更新时间更晚的那个。
  const groups = new Map();
  for (const f of facts) {
    const key = String(f.name ?? '').replace(/\s+/gu, '').replace(/[·•/\\|,，。.、:：;；()（）[\]【】]/gu, '').toLowerCase();
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const duplicates = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const sorted = list.slice().sort((a, b) => b.rounds - a.rounds || b.lastActiveAt - a.lastActiveAt);
    const target = sorted[0];
    for (const source of sorted.slice(1)) {
      const item = {
        ...source, kind: 'review', reason: 'duplicate-name', label: '疑似重复',
        suggestedInto: { id: target.id, name: target.name },
      };
      duplicates.push(item);
      add(review, item);
    }
  }

  // 超过活跃上限时只建议最久未用的，绝不自动删。
  const excess = Math.max(0, facts.length - activeLimit);
  let overLimit = [];
  if (excess > 0) {
    overLimit = facts.slice()
      .filter(f => !seen.has(f.id))
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt)
      .slice(0, excess)
      .map(f => ({ ...f, kind: 'review', reason: 'over-limit', label: '超出活跃上限' }));
    for (const item of overLimit) add(review, item);
  }

  return {
    now,
    activeLimit,
    emptyTtlMs: emptyTtl,
    staleMs,
    lowRounds,
    total: facts.length,
    counts: {
      auto: auto.length,
      review: review.length,
      empty: auto.filter(x => x.reason === 'empty-shell').length,
      stale: auto.filter(x => x.reason === 'stale').length,
      low: review.filter(x => x.reason === 'low-activity').length,
      duplicates: duplicates.length,
      overLimit: overLimit.length,
    },
    auto,
    review,
    duplicates,
    overLimit,
    candidates: [...auto, ...review],
  };
}
