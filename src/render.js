/* 等距 2.5D 渲染：悬浮木砖、机关图标、带真实绕边旋转的 1×1×2 木块。 */
(function (root) {
  'use strict';
  const R = root.WoodRules;

  const FACES = [
    { idx: [4, 6, 7, 5], color: '#d7a15f', normal: [1, 0, 0] },
    { idx: [0, 1, 3, 2], color: '#96602f', normal: [-1, 0, 0] },
    { idx: [2, 3, 7, 6], color: '#b37c42', normal: [0, 1, 0] },
    { idx: [0, 4, 5, 1], color: '#804c26', normal: [0, -1, 0] },
    { idx: [1, 5, 7, 3], color: '#f7d9a6', normal: [0, 0, 1] },
    { idx: [0, 2, 6, 4], color: '#71432a', normal: [0, 0, -1] }
  ];
  const VIEW = [1, 1, 1];

  function lerp(a, b, t) { return a + (b - a) * t; }
  function mix(p, q, t) { return [lerp(p[0], q[0], t), lerp(p[1], q[1], t), lerp(p[2], q[2], t)]; }
  function path(ctx, pts, fill, stroke, width) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = width || 1; ctx.stroke(); }
  }
  function ease(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function hash(x, y) { return ((x * 73 + y * 151) % 17) / 17; }

  function boxVertices(box) {
    const v = [];
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        for (let k = 0; k < 2; k++) {
          v.push([i ? box.x1 : box.x0, j ? box.y1 : box.y0, k ? box.z1 : 0]);
        }
      }
    }
    return v;
  }

  function rotator(box, dir, theta) {
    const d = R.VEC[dir];
    const axisX = d[0] ? (d[0] > 0 ? box.x1 : box.x0) : null;
    const axisY = d[1] ? (d[1] > 0 ? box.y1 : box.y0) : null;
    const sign = d[0] || d[1];
    const c = Math.cos(theta), s = Math.sin(theta);
    return function (p) {
      if (axisX !== null) {
        const u = (p[0] - axisX) * sign, v = p[2];
        return [axisX + (u * c + v * s) * sign, p[1], -u * s + v * c];
      }
      const u = (p[1] - axisY) * sign, v = p[2];
      return [p[0], axisY + (u * c + v * s) * sign, -u * s + v * c];
    };
  }

  function sinkVertices(vertices, amount, scale) {
    const cx = vertices.reduce(function (a, p) { return a + p[0]; }, 0) / 8;
    const cy = vertices.reduce(function (a, p) { return a + p[1]; }, 0) / 8;
    return vertices.map(function (p) {
      return [cx + (p[0] - cx) * scale, cy + (p[1] - cy) * scale, p[2] - amount];
    });
  }

  /* 把多边形裁到 Z>=0：木块沉到洞口平面以下的部分不再绘制，形成「被洞吞进去」的效果。 */
  function clipAboveZero(poly) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const ain = a[2] >= 0, bin = b[2] >= 0;
      if (ain) out.push(a);
      if (ain !== bin) {
        const t = -a[2] / (b[2] - a[2]);
        out.push([lerp(a[0], b[0], t), lerp(a[1], b[1], t), 0]);
      }
    }
    return out;
  }

  class BoardView {
    constructor(canvas, board) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.board = board;
      this.resize();
    }

    setBoard(board) { this.board = board; this.resize(); }

    resize() {
      const cw = Math.max(240, this.canvas.clientWidth || 640);
      const ch = Math.max(240, this.canvas.clientHeight || 420);
      const dpr = Math.min(2, root.devicePixelRatio || 1);
      this.canvas.width = Math.round(cw * dpr);
      this.canvas.height = Math.round(ch * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.cw = cw; this.ch = ch;
      const n = this.board.w + this.board.h;
      let tw = Math.min(2 * (cw - 44) / n, (ch - 44) / (n / 4 + 2.4));
      tw = Math.max(13, Math.min(92, tw));
      this.TW = tw; this.TH = tw / 2; this.ZH = tw / 2;
      this.ox = cw / 2 - (this.board.w - this.board.h) * tw / 4;
      this.oy = ch / 2 - (n * this.TH / 4 - this.ZH);
    }

    p(X, Y, Z) {
      return [this.ox + (X - Y) * this.TW / 2,
              this.oy + (X + Y) * this.TH / 2 - Z * this.ZH];
    }

    diamond(x, y, z) {
      return [this.p(x, y, z), this.p(x + 1, y, z),
              this.p(x + 1, y + 1, z), this.p(x, y + 1, z)];
    }

    isBridgeOpen(ch, bridges) {
      if (ch < '1' || ch > '4') return true;
      return !!((bridges >> (ch.charCodeAt(0) - 49)) & 1);
    }

    render(state, anim, ts) {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.cw, this.ch);
      const bridges = state[4];
      const board = this.board;
      const pulse = 0.5 + 0.5 * Math.sin(ts / 480);

      const tiles = [];
      for (let y = 0; y < board.h; y++) {
        for (let x = 0; x < board.w; x++) {
          const ch = board.cells[y][x];
          if (ch !== ' ') tiles.push({ x: x, y: y, ch: ch, d: x + y });
        }
      }
      tiles.sort(function (a, b) { return a.d - b.d || a.x - b.x; });
      for (let i = 0; i < tiles.length; i++) {
        this.drawTile(tiles[i], bridges, pulse, ts);
      }

      const sink = anim && anim.type === 'win'
        ? Math.min(1, Math.max(0, (anim.t - 0.42) / 0.58)) : 0;
      const inHole = R.isUpright(state) &&
        state[0] === board.goal[0] && state[1] === board.goal[1];
      if (inHole && !anim) {
        // 木块已经滑进洞里：只留下带内壁的洞口，不再把木块画回来
        this.drawHoleForeground(1);
      } else {
        this.drawShadow(state, anim, sink);
        this.drawBlock(state, anim, ts, sink);
        if (sink > 0) this.drawHoleForeground(sink);
      }
    }

    /* 洞口近侧内壁 + 亮边 + 落底涟漪：画在木块之后，把下沉的木块「挡」在洞里。 */
    drawHoleForeground(sink) {
      const ctx = this.ctx;
      const gx = this.board.goal[0], gy = this.board.goal[1];
      const A = this.p(gx, gy, 0), B = this.p(gx + 1, gy, 0);
      const C = this.p(gx + 1, gy + 1, 0), D = this.p(gx, gy + 1, 0);
      const dz = -0.85;
      const B2 = this.p(gx + 1, gy, dz), C2 = this.p(gx + 1, gy + 1, dz);
      const D2 = this.p(gx, gy + 1, dz);
      ctx.save();
      ctx.globalAlpha = Math.min(1, sink * 4);
      const wall1 = ctx.createLinearGradient(B[0], B[1], B2[0], B2[1]);
      wall1.addColorStop(0, '#573c22');
      wall1.addColorStop(1, '#160f09');
      path(ctx, [B, C, C2, B2], wall1, 'rgba(0,0,0,0.45)', 1);
      const wall2 = ctx.createLinearGradient(D[0], D[1], D2[0], D2[1]);
      wall2.addColorStop(0, '#412c19');
      wall2.addColorStop(1, '#120c08');
      path(ctx, [D, C, C2, D2], wall2, 'rgba(0,0,0,0.45)', 1);
      ctx.strokeStyle = 'rgba(255,216,150,0.5)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(B[0], B[1]);
      ctx.lineTo(C[0], C[1]);
      ctx.lineTo(D[0], D[1]);
      ctx.stroke();
      const glow = 0.45 + 0.45 * Math.sin(sink * Math.PI);
      path(ctx, [A, B, C, D], null, 'rgba(255,205,110,' + glow.toFixed(2) + ')', 2 + sink * 1.6);
      if (sink > 0.7) {
        const r = (sink - 0.7) / 0.3;
        const c = this.p(gx + 0.5, gy + 0.5, 0.03);
        ctx.globalAlpha = (1 - r) * 0.8;
        ctx.strokeStyle = 'rgba(255,214,140,0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(c[0], c[1], this.TW * (0.26 + r * 0.62),
                    this.TH * (0.26 + r * 0.62), 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    drawTile(tile, bridges, pulse, ts) {
      const ctx = this.ctx;
      const x = tile.x, y = tile.y, ch = tile.ch;
      const open = this.isBridgeOpen(ch, bridges);
      const top = this.diamond(x, y, 0);
      const isBridge = ch >= '1' && ch <= '4';

      if (!open) {
        ctx.save();
        ctx.setLineDash([4, 4]);
        path(ctx, top, 'rgba(126,160,168,0.07)', 'rgba(140,190,196,0.28)', 1);
        ctx.restore();
        return;
      }

      const d = this.ZH * 0.34;
      const sideX = [this.p(x + 1, y, 0), this.p(x + 1, y + 1, 0),
                     this.p(x + 1, y + 1, -d / this.ZH), this.p(x + 1, y, -d / this.ZH)];
      const sideY = [this.p(x, y + 1, 0), this.p(x + 1, y + 1, 0),
                     this.p(x + 1, y + 1, -d / this.ZH), this.p(x, y + 1, -d / this.ZH)];
      path(ctx, sideX, '#6b4529', 'rgba(35,20,10,0.35)', 0.8);
      path(ctx, sideY, '#52331e', 'rgba(35,20,10,0.35)', 0.8);

      let fill = '#b98a58';
      if (ch === '~') fill = '#d98b3f';
      else if (isBridge) fill = '#8fa9a6';
      else if (ch === 'O') fill = '#2a201c';

      path(ctx, top, fill, 'rgba(52,30,14,0.62)', 1.2);
      ctx.strokeStyle = 'rgba(255,231,190,0.24)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(top[3][0], top[3][1]);
      ctx.lineTo(top[0][0], top[0][1]);
      ctx.lineTo(top[1][0], top[1][1]);
      ctx.stroke();

      // 木纹：两道细线，让每块砖略有差别
      if (ch !== 'O' && !isBridge) {
        const jitter = hash(x, y) * 0.16;
        ctx.strokeStyle = ch === '~' ? 'rgba(110,52,15,0.35)' : 'rgba(96,58,28,0.20)';
        ctx.lineWidth = 1;
        for (let k = 0; k < 2; k++) {
          const t = 0.3 + k * 0.28 + jitter;
          const a = mix([x, y, 0], [x, y + 1, 0], t);
          const b = mix([x + 1, y, 0], [x + 1, y + 1, 0], t);
          const pa = this.p(a[0], a[1], 0.01), pb = this.p(b[0], b[1], 0.01);
          ctx.beginPath(); ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]); ctx.stroke();
        }
      }
      if (ch === '~') {
        ctx.strokeStyle = 'rgba(80,38,12,0.55)';
        ctx.lineWidth = 1.1;
        const a = this.p(x + 0.18, y + 0.68, 0.01);
        const b = this.p(x + 0.48, y + 0.42, 0.01);
        const c = this.p(x + 0.78, y + 0.58, 0.01);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(c[0], c[1]); ctx.stroke();
      }

      if (ch === 'O') {
        const inner = [this.p(x + 0.16, y + 0.16, 0.005), this.p(x + 0.84, y + 0.16, 0.005),
                       this.p(x + 0.84, y + 0.84, 0.005), this.p(x + 0.16, y + 0.84, 0.005)];
        path(ctx, inner, '#0d0b0a', 'rgba(255,196,92,' + (0.45 + pulse * 0.45).toFixed(2) + ')', 2);
        const c = this.p(x + 0.5, y + 0.5, 0.02);
        const g = ctx.createRadialGradient(c[0], c[1], 1, c[0], c[1], this.TW * 0.45);
        g.addColorStop(0, 'rgba(255,190,84,' + (0.10 + pulse * 0.16).toFixed(2) + ')');
        g.addColorStop(1, 'rgba(255,190,84,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(c[0], c[1], this.TW * 0.45, 0, Math.PI * 2); ctx.fill();
        return;
      }

      const center = this.p(x + 0.5, y + 0.5, 0.015);
      const unit = this.TW / 2;
      if (isBridge) {
        ctx.fillStyle = 'rgba(24,50,52,0.75)';
        ctx.font = '600 ' + Math.max(9, unit * 0.42) + 'px system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(ch, center[0], center[1]);
      }
      if (ch === 'o' || ch === 'x' || ch === 't') {
        const sw = this.board.switches.filter(function (s) { return s.x === x && s.y === y; })[0];
        const lit = sw ? this.isBridgeOpen(String(sw.bridge), bridges) : false;
        const color = lit ? '#7fe7c4' : '#f2c46a';
        ctx.save();
        ctx.translate(center[0], center[1]);
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = Math.max(1.4, unit * 0.11);
        ctx.shadowColor = color;
        ctx.shadowBlur = 8 + pulse * 6;
        const r = unit * 0.32;
        if (ch === 'o') {
          ctx.beginPath(); ctx.ellipse(0, 0, r, r * 0.5, 0, 0, Math.PI * 2); ctx.stroke();
          ctx.beginPath(); ctx.ellipse(0, 0, r * 0.42, r * 0.21, 0, 0, Math.PI * 2); ctx.fill();
        } else if (ch === 'x') {
          ctx.beginPath(); ctx.moveTo(-r, -r * 0.5); ctx.lineTo(r, r * 0.5);
          ctx.moveTo(r, -r * 0.5); ctx.lineTo(-r, r * 0.5); ctx.stroke();
        } else {
          ctx.beginPath(); ctx.moveTo(0, -r * 0.62); ctx.lineTo(r, 0);
          ctx.lineTo(0, r * 0.62); ctx.lineTo(-r, 0); ctx.closePath(); ctx.stroke();
        }
        ctx.restore();
      }

      for (let i = 0; i < this.board.teleports.length; i++) {
        const tp = this.board.teleports[i];
        const isFrom = tp.from[0] === x && tp.from[1] === y;
        const isTo = tp.to[0] === x && tp.to[1] === y;
        if (!isFrom && !isTo) continue;
        ctx.save();
        ctx.translate(center[0], center[1]);
        ctx.strokeStyle = isFrom ? '#77e0ff' : 'rgba(119,224,255,0.45)';
        ctx.lineWidth = Math.max(1.4, unit * 0.1);
        ctx.shadowColor = '#5cd6ff';
        ctx.shadowBlur = isFrom ? 12 : 4;
        const r = unit * 0.34;
        ctx.beginPath(); ctx.ellipse(0, 0, r, r * 0.5, 0, 0, Math.PI * 2); ctx.stroke();
        if (isFrom) {
          ctx.rotate(ts / 900);
          ctx.beginPath(); ctx.ellipse(0, 0, r * 0.62, r * 0.31, 0, 0, Math.PI * 1.2); ctx.stroke();
        }
        ctx.restore();
      }
    }

    drawShadow(state, anim, sink) {
      const ctx = this.ctx;
      const cells = R.footprint(anim && anim.type === 'roll' ? anim.from : state);
      const xs = cells.map(function (c) { return c[0]; });
      const ys = cells.map(function (c) { return c[1]; });
      const x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs) + 1;
      const y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys) + 1;
      const quad = [this.p(x0, y0, 0.012), this.p(x1, y0, 0.012),
                    this.p(x1, y1, 0.012), this.p(x0, y1, 0.012)];
      const alpha = anim && anim.type === 'win' ? 0.18 * (1 - (sink || 0))
        : (anim && anim.type === 'fall' ? 0.06 : 0.2);
      path(ctx, quad, 'rgba(18,10,6,' + alpha.toFixed(3) + ')', null, 0);
    }

    drawBlock(state, anim, ts, sink) {
      const ctx = this.ctx;
      let box = R.boxOf(state);
      let vertices = boxVertices(box);
      let alpha = 1;
      let lift = 0;

      if (anim) {
        const t = Math.min(1, Math.max(0, anim.t));
        const e = ease(t);
        if (anim.type === 'roll') {
          const fromBox = R.boxOf(anim.from);
          const rotate = rotator(fromBox, anim.dir, e * Math.PI / 2);
          vertices = boxVertices(fromBox).map(rotate);
          lift = Math.sin(e * Math.PI) * 0.06;
        } else if (anim.type === 'teleport') {
          const shrinking = t < 0.5;
          const b = R.boxOf(shrinking ? anim.from : state);
          const scale = shrinking ? Math.max(0.02, 1 - t * 2) : Math.max(0.02, (t - 0.5) * 2);
          vertices = sinkVertices(boxVertices(b), 0, scale);
          alpha = Math.min(1, scale * 1.5);
        } else if (anim.type === 'fall') {
          vertices = boxVertices(R.boxOf(anim.from));
          const rotate = rotator(R.boxOf(anim.from), anim.dir, e * 0.5);
          vertices = vertices.map(rotate);
          vertices = vertices.map(function (p) { return [p[0], p[1], p[2] - e * 3.2]; });
          alpha = 1 - e;
        } else if (anim.type === 'win') {
          if (t < 0.42) {
            // 最后一滚：照常绕棱翻到洞口正上方
            const fromBox = R.boxOf(anim.from);
            const rotate = rotator(fromBox, anim.dir, ease(t / 0.42) * Math.PI / 2);
            vertices = boxVertices(fromBox).map(rotate);
          } else {
            // 重力加速下沉：k² 缓动 + 轻微透视收缩 + 极细微的摆动
            const k = Math.min(1, (t - 0.42) / 0.58);
            const drop = k * k * 2.8;
            const scale = 1 - k * 0.18;
            const wobble = Math.sin(k * Math.PI * 2.5) * 0.022 * (1 - k);
            vertices = sinkVertices(boxVertices(R.boxOf(state)), drop, scale)
              .map(function (p) { return [p[0] + wobble, p[1] - wobble * 0.6, p[2]]; });
            alpha = 1;
          }
        }
      } else {
        vertices = vertices.map(function (p) {
          return [p[0], p[1], p[2] + Math.sin(ts / 700) * 0.012];
        });
      }
      if (lift) vertices = vertices.map(function (p) { return [p[0], p[1], p[2] + lift]; });

      const center = vertices.reduce(function (a, p) {
        return [a[0] + p[0] / 8, a[1] + p[1] / 8, a[2] + p[2] / 8];
      }, [0, 0, 0]);

      const faces = FACES.map(function (f) {
        const pts = f.idx.map(function (i) { return vertices[i]; });
        const fc = pts.reduce(function (a, p) {
          return [a[0] + p[0] / 4, a[1] + p[1] / 4, a[2] + p[2] / 4];
        }, [0, 0, 0]);
        const n = [fc[0] - center[0], fc[1] - center[1], fc[2] - center[2]];
        return { face: f, pts: pts, depth: fc[0] * VIEW[0] + fc[1] * VIEW[1] + fc[2] * VIEW[2],
                 facing: n[0] * VIEW[0] + n[1] * VIEW[1] + n[2] * VIEW[2] };
      }).filter(function (f) { return f.facing > 0.0001; })
        .sort(function (a, b) { return a.depth - b.depth; });

      const sinking = sink > 0;
      ctx.save();
      ctx.globalAlpha = alpha;
      faces.forEach(function (f) {
        let pts = f.pts;
        if (sinking) {
          pts = clipAboveZero(pts);
          if (pts.length < 3) return;
        }
        const screen = pts.map(function (p) { return this.p(p[0], p[1], p[2]); }, this);
        path(ctx, screen, f.face.color, 'rgba(58,30,10,0.72)', 1.4);
      }, this);

      // 顶面木纹 + 竖立时的年轮（下沉阶段省略，避免木纹越过洞口平面）
      const topFace = sinking ? null : faces.filter(function (f) { return f.face.normal[2] === 1; })[0];
      if (topFace) {
        const pts = topFace.pts;
        const a = pts[0], b = pts[1], c = pts[2], d = pts[3];
        ctx.strokeStyle = 'rgba(120,72,32,0.30)';
        ctx.lineWidth = Math.max(1, this.TW * 0.022);
        for (let k = 1; k <= 3; k++) {
          const t = k / 4;
          const p1 = mix(a, d, t), p2 = mix(b, c, t);
          const s1 = this.p(p1[0], p1[1], p1[2] + 0.004);
          const s2 = this.p(p2[0], p2[1], p2[2] + 0.004);
          ctx.beginPath(); ctx.moveTo(s1[0], s1[1]); ctx.lineTo(s2[0], s2[1]); ctx.stroke();
        }
        if (!anim && R.isUpright(state)) {
          const cc = this.p((a[0] + c[0]) / 2, (a[1] + c[1]) / 2, a[2] + 0.006);
          ctx.strokeStyle = 'rgba(120,72,32,0.32)';
          ctx.lineWidth = 1;
          for (let k = 1; k <= 2; k++) {
            ctx.beginPath();
            ctx.ellipse(cc[0], cc[1], this.TW * 0.11 * k, this.TH * 0.11 * k, 0, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      }
      ctx.restore();
    }
  }

  root.WoodView = { BoardView: BoardView };
})(typeof globalThis !== 'undefined' ? globalThis : this);
