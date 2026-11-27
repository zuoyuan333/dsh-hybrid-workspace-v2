// 纯文本工具：分词、IDF、实体、句子、相似度。零依赖、零 DSH import。
// 设计原则：中文用二元组 + 短词整体，拉丁用词/编号/路径；所有判分都基于可解释的集合运算。

const STOP = new Set([
  '这个', '那个', '我们', '你们', '他们', '她们', '它们', '自己', '什么', '怎么', '为什么',
  '可以', '需要', '应该', '已经', '还是', '就是', '不是', '没有', '因为', '所以', '但是',
  '而且', '如果', '现在', '时候', '一下', '然后', '这样', '那样', '这些', '那些', '一个',
  '一种', '进行', '通过', '对于', '关于', '以及', '或者', '不过', '只是', '还有', '这里',
  '那里', '哪里', '多少', '是否', '能否', '要不要', '能不能', '是不是', '有没有', '的话',
  '说的', '看了', '用了', '好的', '收到', '谢谢', '麻烦', '帮我', '请问', '继续', '同时',
  '目前', '之前', '之后', '上面', '下面', '里面', '外面', '开始', '结束', '问题', '情况',
  '东西', '地方', '时间', '时候', '部分', '方面', '方式', '方法', '结果', '内容', '用户',
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'are', 'was', 'were',
  'you', 'your', 'not', 'but', 'can', 'will', 'would', 'should', 'could', 'about', 'into',
  'http', 'https', 'www', 'com', 'org', 'net', 'true', 'false', 'null', 'undefined'
]);

const WEAK_EDGE = new Set([...'的了是在这那又和把被就都也还要不没有上下中个我你他她们来到对从与或及等再才只更最很会能可该其之为以于并而但如若则且让使给向往至由着过吗呢吧啊呀哦嗯']);

const ENTITY_RE = /[A-Za-z][A-Za-z0-9_.-]{1,}(?:\/[A-Za-z0-9_.-]+)*|\d{3,}(?:\.\d+)*|[A-Za-z0-9_.-]+\.(?:js|ts|mjs|cjs|json|log|md|ya?ml|conf|sh|py|sql|html|css)/gu;

export const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export const clipped = (s, n = 200) => {
  const t = clean(s);
  if (!t || t.length <= n) return t;
  return t.slice(0, Math.max(1, n - 1)) + '…';
};

export function hash (s, len = 12) {
  // 只用于稳定 id / 去重键，不用于安全目的。
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const t = String(s ?? '');
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  const a = (h1 >>> 0).toString(16).padStart(8, '0');
  const b = (h2 >>> 0).toString(16).padStart(8, '0');
  return (a + b).slice(0, len);
}

export function tokens (s) {
  const set = new Set();
  const t = String(s ?? '').toLowerCase();
  for (const w of t.match(/[a-z0-9][a-z0-9_.\/-]*/g) ?? []) {
    if (w.length >= 2 && !STOP.has(w)) set.add(w);
    if (/^\d{3,}$/.test(w)) set.add(w);
  }
  const cjk = t.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjk) {
    if (run.length === 1) { if (!WEAK_EDGE.has(run)) set.add(run); continue; }
    if (run.length <= 4 && !STOP.has(run)) set.add(run);
    for (let i = 0; i + 1 < run.length; i++) {
      const bg = run.slice(i, i + 2);
      if (STOP.has(bg)) continue;
      if (WEAK_EDGE.has(bg[0]) && WEAK_EDGE.has(bg[1])) continue;
      set.add(bg);
    }
  }
  return set;
}

// 只在「路由判分」时剔除的报障模板词；它们出现在每条工单里，
// 不能作为「同话题」的证据，但保留在记忆/关键词里，供人阅读。
const ROUTE_BOILERPLATE = new Set([
  '报障', '涉及', '功能', '终端', '类型', '发生', '时间', '故障', '描述',
  '版本', '店铺', '设备', '后台', '配置', '方式', '如何', '当前', '提示', '请求',
  '问题', '其他', '收到', '运维', '及功', '端类', '生时', '障描', '台类',
]);

export function routingTokens (s) {
  const set = tokens(s);
  for (const t of ROUTE_BOILERPLATE) set.delete(t);
  return set;
}

export function entities (s) {
  const out = [];
  const seen = new Set();
  for (const m of String(s ?? '').match(ENTITY_RE) ?? []) {
    const e = m.replace(/[.,;:]+$/, '');
    const k = e.toLowerCase();
    if (e.length < 3 || STOP.has(k) || seen.has(k)) continue;
    seen.add(k); out.push(e);
  }
  return out.slice(0, 12);
}

export function sentences (s) {
  return String(s ?? '')
    .split(/[。！？!?；;\n]+/u)
    .map(x => clean(x))
    .filter(x => x.length >= 4);
}

export function jaccard (a, b) {
  const A = a instanceof Set ? a : new Set(a ?? []);
  const B = b instanceof Set ? b : new Set(b ?? []);
  if (!A.size && !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export function similarity (a, b) {
  return jaccard(tokens(a), tokens(b));
}

export function topKeywords (s, max = 8) {
  const ents = entities(s);
  // 按“出现的句子数”统计频率：tokens 本身是 Set，直接迭代会永远得到 1。
  const counts = new Map();
  for (const sent of sentences(s)) {
    for (const t of tokens(sent)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const rest = [...counts.entries()]
    .filter(([t]) => !ents.some(e => e.toLowerCase() === t))
    .sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length))
    .map(([t]) => t);
  const out = [];
  for (const x of [...ents, ...rest]) {
    const k = String(x).toLowerCase();
    if (!k || out.includes(k)) continue;
    out.push(k);
    if (out.length >= max) break;
  }
  return out;
}

export function stripFiller (s) {
  return clean(s)
    .replace(/^(?:嗯|哦|啊|那个|这个|就是|然后|另外|还有|帮我|请|麻烦|我想|我要|想问|问一下|查一下|看一下|看看|确认一下|说一下)[，,、:：\s]*/u, '')
    .replace(/^(?:想|要|需要)(?:问|查|看|确认)?[一下]*[，,、:：\s]*/u, '');
}

const NAME_FIELDS = '故障描述|问题描述|故障现象|现象描述|问题现象|具体问题|报障内容|详细描述|问题|需求';
const NAME_GENERIC = new Set(['其他', '问题', '报障', 'impos报障', 'impos 报障', '未命名工作区', 'null', 'undefined', 'true', 'false']);

// 报障模板的第一行通常只是【imPOS 报障】；真正有信息的是「故障描述」。
// 只读这一行，避免把终端版本、时间等元数据拼进工作区名。
function reportName (s) {
  const src = String(s ?? '');
  const m = src.match(new RegExp('(?:^|\\n)\\s*(?:[▍|]\\s*)?(?:' + NAME_FIELDS + ')\\s*[：:]\\s*([^\\n]+)', 'u'));
  if (m) {
    let v = m[1].trim().replace(/^[【\[（(]\s*|\s*[】\]）)]$/gu, '');
    v = v.replace(/^(?:收到)?(?:运维)?问题\s*[：:]\s*/u, '');
    // “上传失败: 010500…”这类描述只保留冒号前的中文结论；URL 的 :// 不受影响。
    v = v.replace(/([\u4e00-\u9fa5]{2,})\s*[:：]\s*(?=[\dA-Za-z]).*$/u, '$1');
    if (v) return v;
  }
  if (/【\s*imPOS\s*报障\s*】/iu.test(src)) {
    const f = src.match(/(?:^|\n)\s*(?:[▍|]\s*)?涉及功能\s*[：:]\s*([^\n]+)/u);
    if (f) return 'imPOS 报障 · ' + f[1].trim();
  }
  return '';
}

// 话题拆段或日志粘贴时，名字可能从 JSON 片段的引号/逗号开始；取第一个字段名当标签。
function jsonName (s) {
  const t = String(s ?? '').trim();
  if (!/^[\[{,"']/u.test(t)) return '';
  const m = t.match(/"([A-Za-z_][\w.-]{1,40})"\s*:/u);
  if (!m) return '';
  return NAME_GENERIC.has(m[1].toLowerCase()) ? '' : m[1];
}

function nameClause (s, max, report = false) {
  let t = stripFiller(s).replace(/^[\s"'“”‘’《》【】\[\]()（）▍|]+|[\s"'“”‘’《》【】\[\]()（）▍|]+$/gu, '');
  if (report) t = t.replace(/([\u4e00-\u9fa5]{2,})\s*[:：]\s*(?=[\dA-Za-z]).*$/u, '$1');
  t = t.split(/[，。！？!?；;、\n]/u)[0] ?? t;
  t = t.replace(/(?:怎么办|怎么处理|如何解决|怎么弄|吗|呢|吧|啊|呀)[。！!？?\s]*$/u, '');
  t = clean(t);
  if (t.length > max) t = t.slice(0, max);
  return t;
}

export function heuristicName (s, max = 18) {
  const report = reportName(s);
  const json = jsonName(s);
  let t = nameClause(report || json || s, max, Boolean(report));
  if (!t || NAME_GENERIC.has(t.toLowerCase())) {
    const kw = topKeywords(s, 3).join(' ');
    if (kw) t = nameClause(kw, max);
  }
  return t || '未命名工作区';
}

export function nowIso (ts = Date.now()) {
  return new Date(ts).toISOString();
}

export function idfMap (docs) {
  const n = Math.max(1, docs.length);
  const df = new Map();
  for (const doc of docs) for (const t of doc) df.set(t, (df.get(t) ?? 0) + 1);
  const out = new Map();
  for (const [t, d] of df) out.set(t, Math.log(1 + n / (1 + d)));
  return out;
}

export function fieldTokenSets (ws) {
  const fields = {
    name: tokens(ws.name),
    keywords: tokens((ws.keywords ?? []).join(' ')),
    description: tokens(ws.description),
  };
  const ex = new Set();
  for (const e of ws.exemplars ?? []) for (const t of tokens(e.text ?? e)) ex.add(t);
  fields.exemplars = ex;
  const mem = new Set();
  for (const m of ws.memories ?? []) {
    if (m.status && m.status !== 'active') continue;
    for (const t of tokens((m.text ?? '') + ' ' + (m.keys ?? []).join(' '))) mem.add(t);
  }
  fields.memories = mem;
  fields.summary = tokens(ws.summary);
  return fields;
}

export const FIELD_WEIGHTS = { name: 1, keywords: 0.95, description: 0.75, exemplars: 0.6, memories: 0.55, summary: 0.45 };
