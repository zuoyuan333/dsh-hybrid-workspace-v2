import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrMigrate } from '../lib/store.js';

const home = mkdtempSync(join(tmpdir(), 'hw-v2-corrupt-'));
const dir = join(home, 'hybrid-workspace-v2');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'state.json'), '{ this is not json', 'utf8');

let fails = 0;
const ok = (name, cond, detail = '') => { if (!cond) fails++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const logs = [];
const r = await loadOrMigrate({ dshHome: home, log: m => logs.push(String(m)) });
ok('损坏状态回退为空状态', r.state.workspaces.length === 0 && r.state.version === 2);
const backups = readdirSync(dir).filter(f => f.startsWith('state.json.corrupt-'));
ok('损坏文件已备份', backups.length === 1, backups.join(','));
ok('备份内容保留原字节', backups.length === 1 && readFileSync(join(dir, backups[0]), 'utf8') === '{ this is not json');
ok('日志提示损坏', logs.some(l => l.includes('state corrupt')), logs.join('|'));
ok('新状态已落盘', (() => { try { return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).version === 2; } catch { return false; } })());

// 备份失败时必须停止重建，不能覆盖唯一的损坏原件。
const homeFail = mkdtempSync(join(tmpdir(), 'hw-v2-corrupt-fail-'));
const dirFail = join(homeFail, 'hybrid-workspace-v2');
mkdirSync(dirFail, { recursive: true });
const original = '{ still broken, do not overwrite';
writeFileSync(join(dirFail, 'state.json'), original, 'utf8');
mkdirSync(join(dirFail, 'state.json.corrupt-424242'));
const realNow = Date.now;
Date.now = () => 424242;
let backupFailure = null;
try { await loadOrMigrate({ dshHome: homeFail }); } catch (error) { backupFailure = error; }
finally { Date.now = realNow; }
ok('备份失败会中止加载', Boolean(backupFailure), String(backupFailure?.message));
ok('备份失败错误可读', String(backupFailure?.message).includes('备份失败'), String(backupFailure?.message));
ok('原损坏状态未被覆盖', readFileSync(join(dirFail, 'state.json'), 'utf8') === original);
ok('未生成新的空状态', !(() => { try { return JSON.parse(readFileSync(join(dirFail, 'state.json'), 'utf8')).version === 2; } catch { return false; } })());

// 未来 schema 不能 normalize 成 v2 后覆盖；旧代码必须停下并保留原文件。
const homeFuture = mkdtempSync(join(tmpdir(), 'hw-v2-future-'));
const dirFuture = join(homeFuture, 'hybrid-workspace-v2');
mkdirSync(dirFuture, { recursive: true });
const futureRaw = JSON.stringify({ version: 99, createdAt: 1, updatedAt: 2, workspaces: [], futureField: 'keep-me' }, null, 2);
writeFileSync(join(dirFuture, 'state.json'), futureRaw, 'utf8');
let futureFailure = null;
try { await loadOrMigrate({ dshHome: homeFuture }); } catch (error) { futureFailure = error; }
ok('未来版本状态拒绝加载', futureFailure?.code === 'STATE_VERSION_UNSUPPORTED', String(futureFailure?.message));
ok('未来版本错误可读', String(futureFailure?.message).includes('99') && String(futureFailure?.message).includes('2'), String(futureFailure?.message));
ok('未来版本原文件未被覆盖', readFileSync(join(dirFuture, 'state.json'), 'utf8') === futureRaw);
ok('未来版本不生成损坏备份', !readdirSync(dirFuture).some(f => f.startsWith('state.json.corrupt-')), readdirSync(dirFuture).join(','));

console.log(fails ? 'CORRUPT FAIL ' + fails : 'CORRUPT PASS');
process.exit(fails ? 1 : 0);
