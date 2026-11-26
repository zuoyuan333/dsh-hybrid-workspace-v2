import { tempHome, sleep } from './fake-ctx.mjs';

process.env.DSH_HOME = tempHome();
const pkgUrl = new URL('../package.json', import.meta.url);
const { readFileSync, existsSync } = await import('node:fs');
const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8'));
const mod = await import('../lib/index.js');

let fails = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) fails++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : ''));
};

ok('包名与导出 name 一致', pkg.name === 'dsh-hybrid-workspace-v2' && mod.name === 'hybrid-workspace', pkg.name + '/' + mod.name);
ok('只声明 systemPrompt 为必需注入', Array.isArray(mod.inject) && mod.inject.length === 1 && mod.inject[0] === 'systemPrompt', JSON.stringify(mod.inject));
ok('apply 是函数', typeof mod.apply === 'function');
ok('DEFAULTS 可读且有关键项', mod.DEFAULTS && mod.DEFAULTS.routeAccept > 0 && mod.DEFAULTS.contextMaxChars > 0);
ok('入口上限与归档保留已调整', mod.DEFAULTS.activeLimit === 12 && mod.DEFAULTS.archiveKeep >= 200, JSON.stringify({ activeLimit: mod.DEFAULTS.activeLimit, archiveKeep: mod.DEFAULTS.archiveKeep }));
ok('版本号已升到 2.8.0', pkg.version === '2.8.0', pkg.version);
ok('声明 lib 深导入与 npm test', pkg.exports?.['./lib/*'] === './lib/*' && pkg.scripts?.test === 'node test/all.mjs', JSON.stringify({ exports: pkg.exports?.['./lib/*'], test: pkg.scripts?.test }));
ok('声明浏览器半边与工作区按钮', pkg.exports?.['./client']?.default === './lib/client.js' && pkg.dsh?.client?.platform === 'web' && existsSync(new URL('../lib/client.js', import.meta.url)), JSON.stringify({ client: pkg.exports?.['./client'], dshClient: pkg.dsh?.client }));
const clientText = existsSync(new URL('../lib/client.js', import.meta.url)) ? readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8') : '';
ok('客户端按钮在会话头部而不是输入框下方', clientText.includes('conversation.session.header.utilities') && !clientText.includes('conversation.input.right'));
ok('客户端用完整地址解析聊天页 URL', clientText.includes('new URL("hybrid-workspace/shell", window.location.href)') && !clientText.includes('window.location.origin'));
ok('客户端在 DSH 窗口内用 iframe 打开面板', clientText.includes('showPanelOverlay(href)') && clientText.includes('hybrid-workspace-overlay') && !clientText.includes('window.open('), clientText.match(/showPanelOverlay\([^)]*\)/)?.[0] ?? '');
ok('客户端保留同源导航兜底与浏览器外开入口', clientText.includes('window.location.assign') && clientText.includes('__DSH_TRANSPORT__') && clientText.includes('浏览器打开'));
ok('package.json 声明 dsh.bundle（DSH 才会加载这个包）', pkg.dsh?.manifestVersion === 1 && typeof pkg.dsh?.bundle?.patch === 'string', JSON.stringify(pkg.dsh ?? null));
const bundlePatchRel = pkg.dsh?.bundle?.patch;
const bundlePatch = bundlePatchRel ? new URL('../' + bundlePatchRel.replace(/^\.\//, ''), import.meta.url) : null;
ok('dsh.bundle.patch 指向的文件存在', bundlePatch !== null && existsSync(bundlePatch), bundlePatch?.pathname ?? 'missing');
const bundleText = bundlePatch && existsSync(bundlePatch) ? readFileSync(bundlePatch, 'utf8') : '';
ok('bundle patch 含 hybrid-workspace insert', /-\s*id:\s*hybrid-workspace/.test(bundleText));

const sections = [];
const handlers = {};
const ctx = {
  on: (name, fn) => { (handlers[name] ??= []).push(fn); },
  systemPrompt: { section: s => sections.push(s), getSectionOrder: () => undefined },
  logger: { info () {}, debug () {} },
};
const inst = mod.apply(ctx, { debug: false });
await sleep(80);
ok('系统提示词 section 已注册', sections.length === 1 && sections[0].name === 'hybrid-workspace', String(sections.length));
ok('未绑定工作区时注入为空', sections[0]?.text?.({ agent: { session: { id: 'nope' } } }) === '');
ok('pre-step 钩子已注册', (handlers['agent/pre-step'] ?? []).length === 1);
ok('session/event 钩子已注册', (handlers['session/event'] ?? []).length === 1);
let noWebError = null;
try {
  const noWeb = {
    on: () => {},
    systemPrompt: { section: () => {}, getSectionOrder: () => undefined },
    logger: { info () {}, debug () {} },
  };
  await mod.apply(noWeb, { debug: false }).flush();
} catch (error) {
  noWebError = error;
}
ok('无 webServer 时不抛错', noWebError === null, noWebError ? String(noWebError?.message ?? noWebError) : '');
await inst.flush();

console.log(fails ? 'LOAD FAIL ' + fails : 'LOAD PASS');
process.exit(fails ? 1 : 0);
