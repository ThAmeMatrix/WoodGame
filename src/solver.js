/* BFS 求解器：既用于开发期证明关卡可解，也用于游戏内的「下一步提示」。
   状态空间包含木块姿态、桥位图、开关按压位图，因此机关关同样能求最优解。 */
(function (root) {
  'use strict';

  function getRules() {
    return typeof module !== 'undefined' && module.exports
      ? require('./rules.js') : root.WoodRules;
  }

  function key(s) { return s[0] + ',' + s[1] + ',' + s[2] + ',' + s[3] + ',' + s[4] + ',' + s[5]; }

  function solveFrom(board, start, maxStates) {
    const R = getRules();
    const limit = maxStates || 400000;
    const queue = [start];
    const parents = new Map();
    parents.set(key(start), null);
    let head = 0;
    let answer = null;

    while (head < queue.length) {
      const state = queue[head++];
      const sKey = key(state);
      for (let i = 0; i < R.DIRS.length; i++) {
        const dir = R.DIRS[i];
        const out = R.step(board, state, dir);
        if (out.result === 'win') {
          answer = { last: sKey, dir: dir };
          break;
        }
        if (out.result === 'ok') {
          const k = key(out.state);
          if (!parents.has(k)) {
            parents.set(k, { prev: sKey, dir: dir });
            queue.push(out.state);
            if (parents.size > limit) return { path: null, explored: parents.size };
          }
        }
      }
      if (answer) break;
    }

    if (!answer) return { path: null, explored: parents.size };
    const path = [answer.dir];
    let cursor = answer.last;
    while (parents.get(cursor)) {
      const p = parents.get(cursor);
      path.push(p.dir);
      cursor = p.prev;
    }
    path.reverse();
    return { path: path, explored: parents.size };
  }

  function solve(level) {
    const R = getRules();
    const board = R.parse(level);
    return solveFrom(board, board.initial);
  }

  const api = { solve: solve, solveFrom: solveFrom, key: key };
  root.WoodSolver = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
