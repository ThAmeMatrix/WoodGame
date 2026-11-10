/* Node 端交叉验证：用浏览器同一份 rules.js / solver.js 重新求解全部关卡，
   结果与 Python 版验证器（tools/verify_levels.py）及 levels.js 的 par 必须完全一致。 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sandbox = { window: {}, console: console };
vm.runInNewContext(fs.readFileSync(path.join(root, 'src/levels.js'), 'utf8'), sandbox);
const levels = sandbox.window.WOOD_LEVELS;
const R = require('../src/rules.js');
const S = require('../src/solver.js');

let ok = true;
console.log('#   名称           par   JS解   状态数  一致  最短解');
for (const level of levels) {
  const board = R.parse(level);
  const result = S.solve(level);
  const steps = result.path ? result.path.length : -1;
  const match = result.path && steps === level.par;
  if (!match) ok = false;

  // 回放一遍，确认求解器给出的路径确实能把木块送进洞里
  let replayOk = !!result.path;
  if (result.path) {
    let state = board.initial;
    for (let i = 0; i < result.path.length; i++) {
      const out = R.step(board, state, result.path[i]);
      const expected = i === result.path.length - 1 ? 'win' : 'ok';
      if (out.result !== expected) { replayOk = false; break; }
      state = out.state;
    }
    if (!R.isUpright(state)) replayOk = false;
    if (state[0] !== board.goal[0] || state[1] !== board.goal[1]) replayOk = false;
  }
  if (!replayOk) ok = false;

  console.log(
    String(level.id).padEnd(4) +
    level.name.padEnd(12) +
    String(level.par).padStart(5) +
    String(steps).padStart(7) +
    String(result.explored).padStart(9) +
    (match && replayOk ? '   OK  ' : '   FAIL') +
    '  ' + (result.path ? result.path.join('') : 'NO SOLUTION')
  );
}
console.log(ok ? '交叉验证通过' : '交叉验证失败');
process.exit(ok ? 0 : 1);
