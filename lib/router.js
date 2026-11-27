// 工作区路由：字段加权 IDF 覆盖率 + 迟滞（连续两条 / 强信号）+ 短句粘住。
// 借鉴 semantic-router 的"代表性话语"路由、TextTiling 的词面凝聚度、以及
// Claude/ChatGPT Projects 的 workspace card 结构；不引入 embedding。

import { clipped, entities, fieldTokenSets, FIELD_WEIGHTS, hash, heuristicName, idfMap, routingTokens, similarity, stripFiller, tokens, topKeywords } from './text.js';

const DEFAULTS = {
  routeMinScore: 0.1,
  routeAccept: 0.48,
  sameTopicAccept: 0.3,
  routeMargin: 0.1,
  switchMargin: 0.14,
  strongSwitch: 0.5,
  weakSwitch: 0.55,
  strongMargin: 0.3,
  pendingSwitch: 2,
  newTopicConfirm: 0.12,
  newTopicWindowMs: 30 * 60 * 1000,
  shortSticky: 12,
  unseenPenalty: 0.15,
  exemplarKeep: 16,
};

export function buildScorer (workspaces, cfg = {}) {
  const n = Math.max(1, workspaces.length);
  const fieldSets = new Map(workspaces.map(ws => [ws.id, fieldTokenSets(ws)]));
  const docs = [];
  for (const sets of fieldSets.values()) {
    const union = new Set();
    for (const set of Object.values(sets)) for (const t of set) union.add(t);
    docs.push(union);
  }
  const idf = idfMap(docs);
  const unseen = Math.log(1 + n);

  function scoreOne (ws, queryTokens) {
    const sets = fieldSets.get(ws.id) ?? {};
    let denom = 0, num = 0;
    const matched = [];
    for (const t of queryTokens) {
      // 从未在任何工作区出现过的词是「新细节」，不该按最高 IDF 惩罚当前话题；
      // 否则「消息越长、越具体，越容易被判成不匹配」，跨会话回原区会失效。
      const w = idf.get(t) ?? unseen * (cfg.unseenPenalty ?? 0.15);
      denom += w;
      let hit = 0;
      for (const [field, set] of Object.entries(sets)) {
        if (set.has(t)) hit = Math.max(hit, FIELD_WEIGHTS[field] ?? 0.4);
      }
      if (hit > 0) { num += w * hit; matched.push(t); }
    }
    return { score: denom ? num / denom : 0, coverage: queryTokens.size ? matched.length / queryTokens.size : 0, matched };
  }

  function rank (text) {
    const q = routingTokens(text);
    return workspaces.map(ws => {
      const r = scoreOne(ws, q);
      let score = r.score;
      // 工作区名是用户亲手起的强标签；整名出现在句子里时给一个小加成。
      const name = String(ws.name ?? '').trim();
      const exact = name.length >= 2 && String(text).includes(name);
      if (exact) score = Math.min(1, score + 0.18);
      return { ws, score, coverage: r.coverage, matched: r.matched, exact };
    }).sort((a, b) => b.score - a.score || (b.ws.hits ?? 0) - (a.ws.hits ?? 0));
  }

  return { rank, idf, fieldSets };
}

const IDENTITY_FIELDS = ['name', 'keywords', 'description', 'exemplars'];

// 只有用户明确说要「新项目/新工作区」才允许在当前区之外立即建区；
// 普通新话题先挂起（no-signal-stay），第二次同主题才升级，避免每条未命中消息都建区。
const NEW_PROJECT_RE = /(?:新项目|新工作区|新话题|新建工作区|另起一个|另起炉灶|换个项目|另一个项目)/u;

export function isExplicitNewProject (text) {
  return NEW_PROJECT_RE.test(String(text ?? ''));
}

export function workspaceNameKey (s) {
  return String(s ?? '').replace(/[\s，。！？!?；;、/\\]+/g, '').toLowerCase();
}

// 建区前查重：同名/同路径（去掉空白和斜杠后）直接复用旧区，不再新建。
export function findDuplicateWorkspace (workspaces, name) {
  const key = workspaceNameKey(name);
  if (!key) return null;
  return (workspaces ?? []).find(ws => workspaceNameKey(ws.name) === key) ?? null;
}

// 多话题时只认“工作区身份”而不是历史对话：旧消息里的词会把当前区变成万能吸铁石。
export function identityMatches (ws, text) {
  if (!ws) return [];
  const sets = fieldTokenSets(ws);
  const q = routingTokens(text);
  const out = [];
  for (const t of q) {
    if (IDENTITY_FIELDS.some(f => sets[f]?.has(t))) out.push(t);
  }
  return out;
}

function brief (scores) {
  return scores.slice(0, 5).map(s => ({
    id: s.ws.id, name: s.ws.name, score: Math.round(s.score * 1000) / 1000,
    coverage: Math.round((s.coverage ?? 0) * 1000) / 1000,
    matched: (s.matched ?? []).slice(0, 8), exact: s.exact,
  }));
}

export function decideRoute ({ workspaces, session, text, cfg = {} }) {
  const c = { ...DEFAULTS, ...cfg };
  const currentId = session?.workspaceId ?? null;
  if (!workspaces.length) return { action: 'new', how: 'bootstrap', scores: [] };
  const q = routingTokens(text);
  if (!q.size) {
    if (currentId) return { action: 'stay', wsId: currentId, how: 'empty-query', scores: [] };
    return { action: 'new', how: 'bootstrap', scores: [] };
  }
  const scorer = buildScorer(workspaces, c);
  const ranked = scorer.rank(text);
  const top = ranked[0];
  const second = ranked[1];
  const current = ranked.find(x => x.ws.id === currentId);
  const margin = top.score - (second?.score ?? 0);
  const base = {
    scores: brief(ranked), top: brief(ranked)[0], margin: Math.round(margin * 1000) / 1000,
    queryTerms: [...q].slice(0, 20), currentScore: Math.round((current?.score ?? 0) * 1000) / 1000,
  };
  const route = (x, how) => ({ ...base, action: 'route', wsId: x.ws.id, ws: x.ws, how });
  const stay = (how, extra = {}) => ({ ...base, action: 'stay', wsId: currentId, how, ...extra });
  const fresh = (how) => ({ ...base, action: 'new', how });

  // 短句（"继续""好的""那个呢"）天然没有词面信号，优先留在当前区。
  const short = String(text).trim().length < (c.shortSticky ?? 12);

  // 未命中任何区时先留在当前区，并挂起一个「新话题候选」；第二条相似消息才升级建区。
  const noSignal = (how) => {
    const p = session?.newTopic;
    const now = Date.now();
    const recent = p && p.text && now - (Number(p.at) || 0) <= (c.newTopicWindowMs ?? DEFAULTS.newTopicWindowMs);
    const same = recent && similarity(p.text, text) >= (c.newTopicConfirm ?? DEFAULTS.newTopicConfirm);
    if (same) {
      return { ...base, action: 'new', how: 'new-topic-confirmed', name: p.name || heuristicName(p.text, c.nameMaxChars ?? 18) };
    }
    return stay(how, {
      newTopic: { text: clipped(text, 400), name: heuristicName(text, c.nameMaxChars ?? 18), at: now },
      pending: null,
    });
  };

  // 工作区策略可以锁死自动切走：当前区优先，新话题也不自动迁出。
  if (currentId && c.autoSwitch === false) return stay('locked', { pending: null });

  // 明确说「新项目/新工作区」时才跳过两跳确认，立即建区。
  if (currentId && isExplicitNewProject(text)) {
    return { ...fresh('explicit-new'), name: heuristicName(text, c.nameMaxChars ?? 18) };
  }

  // 两跳确认：上一条未命中挂了新话题候选，这一条只要与候选相似就升级。
  // 必须放在短句/弱匹配/强切分支之前，否则第二条被旧区的弱命中截走，候选永远攒不到第二跳。
  const candidate = currentId ? session?.newTopic : null;
  if (candidate?.text) {
    const now = Date.now();
    const recent = now - (Number(candidate.at) || 0) <= (c.newTopicWindowMs ?? DEFAULTS.newTopicWindowMs);
    if (recent && similarity(candidate.text, text) >= (c.newTopicConfirm ?? DEFAULTS.newTopicConfirm)) {
      return { ...fresh('new-topic-confirmed'), name: candidate.name || heuristicName(candidate.text, c.nameMaxChars ?? 18) };
    }
  }

  if (!currentId) {
    if (top.exact || top.score >= c.routeAccept) return route(top, top.exact ? 'exact-name' : 'match');
    if (top.score < c.routeMinScore) return fresh('no-signal');
    if (margin < 0.08 || top.score < c.routeAccept * 0.8) return { ...base, action: 'ask-llm', how: 'ambiguous-new' };
    return route(top, 'weak-match');
  }

  // 只有一个共享词（比如都叫"会员"）不足以认定同话题；至少两个实质命中，
  // 或命中一个实体词（设备号/单号/版本号），才算词面证据。
  const entitySet = new Set(entities(text).map(e => e.toLowerCase()));
  const matched = top.matched ?? [];
  const matchedStrong = top.exact || matched.length >= 2 || matched.some(t => entitySet.has(t));

  // 当前区恰好排在第一位时，只有真的命中才算同话题；零命中必须继续往下走，
  // 否则「只有一个工作区」时任何新话题都会被 same-topic 吞掉（v2 首轮实测 bug）。
  if (top.ws.id === currentId && (top.exact || (top.score >= c.sameTopicAccept && matchedStrong))) {
    return stay('same-topic', { pending: null });
  }
  if (short && !top.exact) return stay('sticky-short', { pending: session?.pending ?? null });
  if (top.score < c.routeMinScore) return noSignal('no-signal-stay');
  // 对旧区的中等匹配（0.48~0.6）不足以单条切走：先挂新话题候选，第二条相似消息再建区。
  // 否则「收银机开机黑屏」这类共享泛词会被并进另一个收银机区，话题永远分不出来。
  if (top.ws.id !== currentId && !top.exact && top.score < (c.weakSwitch ?? DEFAULTS.weakSwitch)) return noSignal('no-signal-stay');
  const currentScore = current?.score ?? 0;
  if (top.ws.id === currentId) {
    // 长句只共享一个泛词：更像新问题，而不是当前话题的延续。
    if (!matchedStrong) return noSignal('weak-current-stay');
    return stay('sticky-weak', { pending: null });
  }
  if (currentScore < c.routeMinScore && top.score < c.routeAccept) return noSignal('no-signal-stay');
  if (top.score < c.routeAccept || margin < c.routeMargin) return stay('sticky-weak', { pending: null });
  if (top.score - currentScore < c.switchMargin) return stay('sticky-margin', { pending: null });

  const strong = top.exact || (top.score >= c.strongSwitch && margin >= c.strongMargin);
  if (strong) return route(top, top.exact ? 'exact-name' : 'strong-signal');

  // 连续两条都指向同一个新候选才真正切换，防止单条弱信号造成抖动。
  const pending = session?.pending && session.pending.id === top.ws.id
    ? { id: top.ws.id, count: (session.pending.count ?? 0) + 1 }
    : { id: top.ws.id, count: 1 };
  if (pending.count >= (c.pendingSwitch ?? 2)) return { ...route(top, 'switch-pending'), pending: null };
  return stay('pending-switch', { pending });
}

// 多话题分段的选择：用户已经显式分段时，旧区只要有两个身份词命中，就优先复用；
// 否则中等匹配（例如 workbuddy 命中 0.42）会因分数没到 routeAccept 被误建成 D。
export function pickMultiTarget ({ scores = [], currentId = null, text = '', workspaces = [], cfg = {} } = {}) {
  const hit = (scores ?? []).find(x => {
    if (!x || x.id === currentId) return false;
    if (x.exact || Number(x.score) >= (cfg.routeAccept ?? DEFAULTS.routeAccept)) return true;
    const ws = (workspaces ?? []).find(w => w.id === x.id);
    return Boolean(ws) && identityMatches(ws, text).length >= (cfg.multiRouteIdentityHits ?? 2);
  });
  return hit ? ((workspaces ?? []).find(w => w.id === hit.id) ?? null) : null;
}

export function createWorkspace (text, cfg = {}) {
  const now = cfg.now ?? Date.now();
  const name = clipped(heuristicName(text, cfg.nameMaxChars ?? 18), 40);
  const id = 'ws_' + hash(name + '|' + text + '|' + now, 8);
  const userText = clipped(stripFiller(text), 200);
  return {
    id,
    name,
    description: clipped(stripFiller(text), 180),
    keywords: topKeywords(text, cfg.keywordMax ?? 8),
    summary: '',
    turns: [],
    memories: [],
    exemplars: userText ? [{ text: userText, at: now }] : [],
    rounds: 0,
    hits: 0,
    createdAt: now,
    updatedAt: now,
  };
}

// 两跳确认建区时，第一条消息已经暂存在旧区；把它（连同同轮回答）搬到新区，
// 否则新话题的开头会留在旧区，新区上下文从第二条才开始。
export function takeRoundTurns (from, to, round) {
  const n = Number(round) || 0;
  if (!from || !to || !n) return 0;
  const keep = [];
  const moved = [];
  for (const t of from.turns ?? []) {
    if ((Number(t.turn ?? t.round) || 0) === n) moved.push(t);
    else keep.push(t);
  }
  if (!moved.some(t => String(t.role ?? 'user') === 'user')) return 0;
  from.turns = keep;
  from.rounds = Math.max(0, (Number(from.rounds) || 0) - 1);
  from.hits = Math.max(0, (Number(from.hits) || 0) - 1);
  to.turns = [...moved.map(t => ({ ...t, turn: 1, round: 1 })), ...(to.turns ?? [])];
  to.rounds = 1;
  return moved.length;
}

export function removeExemplar (ws, text) {
  if (!Array.isArray(ws.exemplars) || !ws.exemplars.length) return 0;
  const t = clipped(stripFiller(text), 200);
  if (!t) return 0;
  const before = ws.exemplars.length;
  ws.exemplars = ws.exemplars.filter(e => similarity(e?.text ?? e, t) < 0.9);
  return before - ws.exemplars.length;
}

export function addExemplar (ws, text, cfg = {}) {
  if (!Array.isArray(ws.exemplars)) ws.exemplars = [];
  const t = clipped(stripFiller(text), 200);
  if (!t) return;
  if ((ws.exemplars ?? []).some(e => similarity(e.text ?? e, t) >= 0.9)) return;
  ws.exemplars.push({ text: t, at: Date.now() });
  const keep = cfg.exemplarKeep ?? DEFAULTS.exemplarKeep;
  if (ws.exemplars.length > keep) ws.exemplars = ws.exemplars.slice(-keep);
}

const MERGE_KEY = (s) => String(s ?? '').replace(/[\s，。！？!?；;、]/g, '').toLowerCase();

function offsetTurns (list, base) {
  return (list ?? []).map(t => {
    const old = Number(t.turn ?? t.round) || 0;
    const turn = old > 0 ? base + old : base + 1;
    return { ...t, turn, round: turn };
  });
}

function maxTurn (list) {
  return (list ?? []).reduce((m, t) => Math.max(m, Number(t.turn ?? t.round) || 0), 0);
}

// rounds 是用户轮数；turns 同时含 user/assistant，不能用 turns.length 当轮数。
function roundCount (list, declared) {
  const users = (list ?? []).filter(t => String(t.role ?? 'user') === 'user').length;
  return Math.max(Number(declared) || 0, users);
}

export function mergeWorkspace (from, into) {
  const intoRounds = roundCount(into.turns, into.rounds);
  const fromRounds = roundCount(from.turns, from.rounds);
  // 轮次偏移只避开目标区已有的最大 turn，不能用 turns.length（会被 assistant 行放大）。
  const base = Math.max(intoRounds, maxTurn(into.turns));
  // 目标在前、来源在后：去重时保留目标版本，不能反过来用来源覆盖目标。
  const turns = [...(into.turns ?? []), ...offsetTurns(from.turns, base)];
  const turnSeen = new Set();
  into.turns = turns.filter(t => {
    const k = String(t.role ?? 'user') + '|' + MERGE_KEY(t.text);
    if (turnSeen.has(k)) return false;
    turnSeen.add(k); return true;
  });

  const memSeen = new Set();
  const memIdSeen = new Set();
  const memories = [];
  for (const m of [...(into.memories ?? []), ...offsetTurns(from.memories, base)]) {
    const id = String(m.id ?? '');
    const key = MERGE_KEY(m.text) || ('id:' + id);
    if (memSeen.has(key) || (id && memIdSeen.has(id))) continue;
    memSeen.add(key);
    if (id) memIdSeen.add(id);
    memories.push(m);
  }
  into.memories = memories;

  const exemplarSeen = new Set();
  into.exemplars = [...(from.exemplars ?? []), ...(into.exemplars ?? [])]
    .filter(e => {
      const k = MERGE_KEY(e.text ?? e);
      if (!k || exemplarSeen.has(k)) return false;
      exemplarSeen.add(k); return true;
    })
    .slice(-DEFAULTS.exemplarKeep);
  // 被合并方的关键词优先保留：它是即将消失那一边唯一的名字线索。
  into.keywords = [...new Set([...(from.keywords ?? []), ...(into.keywords ?? [])])].slice(0, 12);
  const summaries = [into.summary, from.summary].filter(Boolean);
  into.summary = [...new Set(summaries)].join(' / ').slice(0, 700);
  if (from.description && from.description !== into.description) {
    into.description = [into.description, from.description].filter(Boolean).join('；').slice(0, 300);
  }
  into.rounds = intoRounds + fromRounds;
  into.hits = (into.hits ?? 0) + (from.hits ?? 0);
  into.updatedAt = Date.now();
  return into;
}

export { DEFAULTS as ROUTER_DEFAULTS, entities };