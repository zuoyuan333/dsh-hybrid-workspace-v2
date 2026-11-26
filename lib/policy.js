// 工作区级策略：上下文预算、记忆注入条数、是否允许自动切走、会话隔离。
// 纯函数、零 DSH import；旧状态没有 policy 时全部回落到全局默认。

export const POLICY_DEFAULTS = Object.freeze({
  contextMaxChars: null,
  memoryInject: null,
  autoSwitch: true,
  isolation: 'prompt',
});

function intIn (value, min, max) {
  if (value === null || value === undefined || value === '') return null;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

// 只接受明确的布尔写法；旧版把字符串 "false"/0/"no" 都当成 true，等于关不掉自动切走。
function boolIn (value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (['true', 'yes', '1', '是', '开', '允许', 'on'].includes(s)) return true;
    if (['false', 'no', '0', '否', '关', '禁止', 'off'].includes(s)) return false;
  }
  return fallback;
}

export function normalizePolicy (input = {}) {
  const p = input && typeof input === 'object' ? input : {};
  return {
    contextMaxChars: intIn(p.contextMaxChars, 600, 12000),
    memoryInject: intIn(p.memoryInject, 0, 20),
    autoSwitch: boolIn(p.autoSwitch, true),
    isolation: p.isolation === 'session' ? 'session' : 'prompt',
  };
}

export function policyOf (ws) {
  return normalizePolicy(ws?.policy);
}

// 合并全局配置与工作区策略；cap 用于多话题时把单卡预算压在均分值以内。
export function contextCfgFor (ws, cfg = {}, cap = null) {
  const p = policyOf(ws);
  const out = { ...cfg };
  const base = Math.max(600, Number(cfg.contextMaxChars) || 2400);
  let max = p.contextMaxChars ?? base;
  if (Number.isFinite(Number(cap)) && Number(cap) > 0) max = Math.min(max, Number(cap));
  out.contextMaxChars = Math.max(240, max);
  out.contextMinChars = Math.min(Math.max(Number(cfg.contextMinChars) || 800, 400), out.contextMaxChars);
  if (p.memoryInject !== null) out.memoryInject = p.memoryInject;
  return out;
}

export function mayAutoSwitch (ws) {
  return policyOf(ws).autoSwitch !== false;
}

export function policyView (ws) {
  const p = policyOf(ws);
  return {
    contextMaxChars: p.contextMaxChars,
    memoryInject: p.memoryInject,
    autoSwitch: p.autoSwitch,
    isolation: p.isolation,
  };
}