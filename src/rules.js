/* 规则引擎：1×1×2 木块在悬浮木砖上翻滚。
   状态 = [ax, ay, bx, by, bridges, pressed]
   a/b 是木块占据的两格（规范排序）；竖立时 a === b。
   bridges 是桥组开关位图，pressed 是「当前压住哪些开关」的位图。 */
(function (root) {
  'use strict';

  const DIRS = ['U', 'D', 'L', 'R'];
  /* 等距视角下的直觉映射：↑→屏幕左上，→→屏幕右上，↓→屏幕右下，←→屏幕左下。
     投影 sx=(X-Y)*TW/2, sy=(X+Y)*TH/2，故 -X 是左上、+X 是右下、-Y 是右上、+Y 是左下。 */
  const VEC = { U: [-1, 0], D: [1, 0], L: [0, 1], R: [0, -1] };
  const KIND = { o: 'soft', x: 'hard', t: 'toggle' };

  function norm(ax, ay, bx, by) {
    if (ax < bx || (ax === bx && ay <= by)) return [ax, ay, bx, by];
    return [bx, by, ax, ay];
  }

  function parse(level) {
    const rows = level.map.slice();
    const w = Math.max.apply(null, rows.map(function (r) { return r.length; }));
    const cells = rows.map(function (r) { return r.padEnd(w, ' ').split(''); });
    const h = cells.length;
    const board = {
      w: w, h: h, cells: cells,
      goal: null, start: null,
      switches: [], teleports: (level.teleports || []).map(function (t) {
        return { from: t.from.slice(), to: t.to.slice() };
      }),
      bridges0: 0, level: level
    };
    const defs = level.switches || [];
    let switchIndex = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const ch = cells[y][x];
        if (ch === 'S') board.start = [x, y];
        else if (ch === 'O') board.goal = [x, y];
        else if (KIND[ch]) {
          const def = defs[switchIndex++] || {};
          board.switches.push({
            x: x, y: y, kind: KIND[ch],
            bridge: def.bridge || 1,
            action: def.action || (ch === 't' ? 'toggle' : 'open')
          });
        }
      }
    }
    if (switchIndex !== defs.length) {
      console.warn('[wood] 开关数量不匹配：地图 ' + switchIndex + ' / 配置 ' + defs.length);
    }
    (level.bridges || []).forEach(function (open, i) { if (open) board.bridges0 |= 1 << i; });

    const sx = board.start[0], sy = board.start[1];
    const orient = level.orient || 'upright';
    if (orient === 'x') {
      board.initial = norm(sx, sy, sx + 1, sy).concat([board.bridges0, 0]);
    } else if (orient === 'y') {
      board.initial = norm(sx, sy, sx, sy + 1).concat([board.bridges0, 0]);
    } else {
      board.initial = [sx, sy, sx, sy, board.bridges0, 0];
    }
    return board;
  }

  function support(board, x, y, bridges) {
    const row = board.cells[y];
    const ch = row ? row[x] : ' ';
    if (ch === undefined || ch === ' ') return 'void';
    if (ch === 'O') return 'goal';
    if (ch === '~') return 'fragile';
    if (ch >= '1' && ch <= '4') {
      return (bridges >> (ch.charCodeAt(0) - 49)) & 1 ? 'floor' : 'void';
    }
    return 'floor';
  }

  function geometry(s, d) {
    const ax = s[0], ay = s[1], bx = s[2], by = s[3];
    const dx = d[0], dy = d[1];
    if (ax === bx && ay === by) {
      return norm(ax + dx, ay + dy, ax + 2 * dx, ay + 2 * dy);
    }
    const ux = bx - ax, uy = by - ay;
    if ((dx === ux && dy === uy) || (dx === -ux && dy === -uy)) {
      const p1 = ax * dx + ay * dy, p2 = bx * dx + by * dy;
      const hx = p1 > p2 ? ax : bx, hy = p1 > p2 ? ay : by;
      const cx = hx + dx, cy = hy + dy;
      return [cx, cy, cx, cy];
    }
    return norm(ax + dx, ay + dy, bx + dx, by + dy);
  }

  function isUpright(s) { return s[0] === s[2] && s[1] === s[3]; }

  function footprint(s) {
    return isUpright(s) ? [[s[0], s[1]]] : [[s[0], s[1]], [s[2], s[3]]];
  }

  /* 木块占据的世界盒（格子边长 1，Z 向上）。渲染与翻滚动画共用。 */
  function boxOf(s) {
    if (isUpright(s)) return { x0: s[0], y0: s[1], x1: s[0] + 1, y1: s[1] + 1, z1: 2 };
    if (s[1] === s[3]) return { x0: s[0], y0: s[1], x1: s[0] + 2, y1: s[1] + 1, z1: 1 };
    return { x0: s[0], y0: s[1], x1: s[0] + 1, y1: s[1] + 2, z1: 1 };
  }

  function failed(result, s) {
    return { result: result, state: null, info: { from: s } };
  }

  function step(board, s, dir) {
    const d = VEC[dir];
    if (!d) return failed('blocked', s);
    const g = geometry(s, d);
    let ax = g[0], ay = g[1], bx = g[2], by = g[3];
    let upright = ax === bx && ay === by;
    let cells = upright ? [[ax, ay]] : [[ax, ay], [bx, by]];
    let teleported = false;

    if (upright) {
      for (let i = 0; i < board.teleports.length; i++) {
        const tp = board.teleports[i];
        if (ax === tp.from[0] && ay === tp.from[1]) {
          ax = tp.to[0]; ay = tp.to[1]; bx = ax; by = ay;
          cells = [[ax, ay]];
          teleported = true;
          break;
        }
      }
    }

    const bridges0 = s[4];
    let kinds = cells.map(function (c) { return support(board, c[0], c[1], bridges0); });
    if (kinds.indexOf('void') >= 0) return failed('fall', s);
    if (upright && kinds[0] === 'goal') {
      return {
        result: 'win',
        state: [ax, ay, bx, by, bridges0, s[5]],
        info: { teleported: teleported, fired: [], cells: cells, bridges: bridges0 }
      };
    }
    if (!upright && kinds.every(function (k) { return k === 'goal'; })) return failed('fall', s);
    if (upright && kinds[0] === 'fragile') return failed('fragile', s);

    let pressed = 0;
    board.switches.forEach(function (sw, i) {
      const covered = cells.some(function (c) { return c[0] === sw.x && c[1] === sw.y; });
      if (covered && (sw.kind !== 'hard' || upright)) pressed |= 1 << i;
    });

    let bridges = bridges0;
    const fired = [];
    board.switches.forEach(function (sw, i) {
      if (((pressed & ~s[5]) >> i) & 1) {
        const bit = 1 << (sw.bridge - 1);
        if (sw.action === 'open') bridges |= bit;
        else if (sw.action === 'close') bridges &= ~bit;
        else bridges ^= bit;
        fired.push(i);
      }
    });

    kinds = cells.map(function (c) { return support(board, c[0], c[1], bridges); });
    if (kinds.indexOf('void') >= 0) return failed('fall', s);

    const next = [ax, ay, bx, by, bridges, pressed];
    return {
      result: 'ok', state: next,
      info: { teleported: teleported, fired: fired, cells: cells, bridges: bridges }
    };
  }

  const api = {
    DIRS: DIRS, VEC: VEC, parse: parse, step: step, geometry: geometry,
    support: support, norm: norm, isUpright: isUpright,
    footprint: footprint, boxOf: boxOf
  };
  root.WoodRules = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
