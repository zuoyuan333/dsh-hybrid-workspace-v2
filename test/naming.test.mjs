import { heuristicName } from '../lib/text.js';
import { createWorkspace } from '../lib/router.js';

let fails = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) fails++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : ''));
};

const report = [
  '【imPOS 报障】',
  '▍涉及功能：其他',
  '▍终端类型：大POS',
  '▍imPOS版本：4.1.8',
  '▍发生时间：2026-09-14 11:25:00',
  '▍故障描述：没有看到嘉利的签到',
].join('\n');

ok('报障模板优先取故障描述', heuristicName(report) === '没有看到嘉利的签到', heuristicName(report));
ok('报障壳和元数据不会进入名字', !/[▍【】]|报障】/u.test(heuristicName(report)), heuristicName(report));
ok('去掉转述前缀', heuristicName('【imPOS 报障】\n▍涉及功能：后台配置\n▍故障描述：收到运维问题：瑞祥在impos后台如何配置支付方式啊') === '瑞祥在impos后台如何配置支付方式', heuristicName('【imPOS 报障】\n▍涉及功能：后台配置\n▍故障描述：收到运维问题：瑞祥在impos后台如何配置支付方式啊'));
ok('长描述在冒号和 ID 前收口', heuristicName('【imPOS 报障】\n▍涉及功能：其他\n▍故障描述：上传数字化交易平台失败: 010500…0004数字化交易报文build失败') === '上传数字化交易平台失败', heuristicName('【imPOS 报障】\n▍涉及功能：其他\n▍故障描述：上传数字化交易平台失败: 010500…0004数字化交易报文build失败'));
ok('没有故障描述时回退到涉及功能', heuristicName('【imPOS 报障】\n▍涉及功能：其他') === 'imPOS 报障 · 其他', heuristicName('【imPOS 报障】\n▍涉及功能：其他'));
ok('问题字段也能作为名字', heuristicName('问题：会员积分接口返回 500') === '会员积分接口返回 500', heuristicName('问题：会员积分接口返回 500'));

ok('JSON 片段取字段名而不是标点', heuristicName(', "putin_price_num":1') === 'putin_price_num', heuristicName(', "putin_price_num":1'));
ok('普通话题保持原样', heuristicName('供应商对账金额差了两毛三分钱') === '供应商对账金额差了两毛三分钱', heuristicName('供应商对账金额差了两毛三分钱'));
ok('短句保持原样', heuristicName('配置确认都没有问题') === '配置确认都没有问题', heuristicName('配置确认都没有问题'));
ok('空文本回退到未命名', heuristicName('') === '未命名工作区', heuristicName(''));
ok('名字按 max 截断', heuristicName('一二三四五六七八九十', 5) === '一二三四五', heuristicName('一二三四五六七八九十', 5));

const ws = createWorkspace(report);
ok('建区使用新名字', ws.name === '没有看到嘉利的签到' && ws.id.startsWith('ws_'), JSON.stringify({ name: ws.name, id: ws.id }));
ok('建区仍保留原消息用作描述和正例', ws.description.includes('故障描述') && ws.exemplars[0].text.includes('没有看到嘉利的签到'));

if (fails) {
  console.log('\nNAMING FAIL: ' + fails);
  process.exitCode = 1;
} else {
  console.log('\nNAMING PASS');
}
