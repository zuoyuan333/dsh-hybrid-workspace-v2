import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

// 独立壳只允许本机回环地址，避免把本地面板 URL 变成任意启动参数。
export function isLoopbackShellUrl (raw) {
  try {
    const u = new URL(String(raw));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return false;
    return /\/hybrid-workspace\/shell\/?$/u.test(u.pathname);
  } catch { return false; }
}

// 没有 .app 时明确返回“未构建”，由面板回退浏览器窗口；不伪造启动成功。
export function launchShell ({ url, appPath, spawnFn = spawn } = {}) {
  if (process.platform !== 'darwin') return { ok: false, error: '当前平台不支持 macOS 独立壳' };
  if (!isLoopbackShellUrl(url)) return { ok: false, error: '独立壳只允许本机回环地址' };
  if (!appPath || !existsSync(appPath)) return { ok: false, error: '独立壳未构建：' + (appPath || '(未配置路径)') };
  try {
    const child = spawnFn('open', ['-a', String(appPath), '--args', String(url)], { detached: true, stdio: 'ignore' });
    child.unref?.();
    return { ok: true, launched: true };
  } catch (error) {
    return { ok: false, error: '启动独立壳失败：' + String(error?.message ?? error) };
  }
}
