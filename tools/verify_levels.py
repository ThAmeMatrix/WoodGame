#!/usr/bin/env python3
"""关卡验证器：独立实现规则引擎 + BFS，逐关证明可解并量化难度。

用法：
  python tools/verify_levels.py              汇总报告（每关最短步数 / 解法 / 机关使用情况）
  python tools/verify_levels.py --trace 7   打印第 7 关最优解的逐步状态
  python tools/verify_levels.py --probe 7   枚举第 7 关所有可作为终点的格子及其最短步数
  python tools/verify_levels.py --goal 7 9 4 临时把第 7 关终点挪到 (9,4) 后求解
"""
import json
import re
import sys
from collections import deque
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parents[1]
LEVELS_FILE = ROOT / "src" / "levels.js"

# 与 src/rules.js 保持一致：等距视角里 ↑=左上(-X)、→=右上(-Y)、↓=右下(+X)、←=左下(+Y)
DIRS = [("U", -1, 0), ("D", 1, 0), ("L", 0, 1), ("R", 0, -1)]
DIR_VEC = {name: (dx, dy) for name, dx, dy in DIRS}


def load_levels():
    text = LEVELS_FILE.read_text(encoding="utf-8")
    match = re.search(r"/\*DATA\*/(.*?)/\*ENDDATA\*/", text, re.S)
    if not match:
        raise SystemExit("levels.js 缺少 /*DATA*/ ... /*ENDDATA*/ 标记")
    payload = match.group(1)
    payload = payload[payload.index("=") + 1:].strip().rstrip(";")
    # levels.js 的数据区保持严格 JSON 语法，便于此处直接复用为唯一数据源
    return json.loads(payload)


class Board:
    def __init__(self, level):
        rows = [r.ljust(max(len(r) for r in level["map"])) for r in level["map"]]
        self.h = len(rows)
        self.w = len(rows[0])
        self.tiles = {}
        self.goal = None
        self.start = None
        self.switch_cells = []
        for y, row in enumerate(rows):
            for x, ch in enumerate(row):
                if ch == " ":
                    kind = "void"
                elif ch == "#":
                    kind = "floor"
                elif ch == "S":
                    kind, self.start = "floor", (x, y)
                elif ch == "O":
                    kind, self.goal = "goal", (x, y)
                elif ch == "~":
                    kind = "fragile"
                elif ch in "1234":
                    kind = "bridge%d" % int(ch)
                elif ch in "oxt":
                    kind = "floor"
                    self.switch_cells.append((x, y, ch))
                else:
                    raise SystemExit("未知地图字符 %r @ (%d,%d)" % (ch, x, y))
                self.tiles[(x, y)] = kind
        if self.start is None or self.goal is None:
            raise SystemExit("关卡 %s 缺少 S 或 O" % level.get("id"))
        defs = level.get("switches", [])
        if len(defs) != len(self.switch_cells):
            raise SystemExit("关卡 %s：地图上有 %d 个开关，switches 配置有 %d 条" %
                             (level.get("id"), len(self.switch_cells), len(defs)))
        kind_map = {"o": "soft", "x": "hard", "t": "toggle"}
        self.switches = [
            {"x": x, "y": y, "kind": kind_map[ch],
             "bridge": defs[i].get("bridge", 1),
             "action": defs[i].get("action", "toggle" if ch == "t" else "open")}
            for i, (x, y, ch) in enumerate(self.switch_cells)
        ]
        self.teleports = level.get("teleports", [])
        opened = level.get("bridges", [])
        self.bridge0 = 0
        for i, flag in enumerate(opened):
            if flag:
                self.bridge0 |= 1 << i
        orient = level.get("orient", "upright")
        x, y = self.start
        if orient == "upright":
            self.initial = (x, y, x, y, self.bridge0, 0)
        elif orient == "x":
            self.initial = self.norm((x, y), (x + 1, y)) + (self.bridge0, 0)
        elif orient == "y":
            self.initial = self.norm((x, y), (x, y + 1)) + (self.bridge0, 0)
        else:
            raise SystemExit("未知朝向 %r" % orient)

    @staticmethod
    def norm(a, b):
        return tuple((*a, *b)) if a <= b else tuple((*b, *a))

    def support(self, cell, bridges):
        kind = self.tiles.get(cell, "void")
        if kind.startswith("bridge"):
            group = int(kind[-1]) - 1
            return "floor" if (bridges >> group) & 1 else "void"
        return kind

    def geometry(self, state, d):
        ax, ay, bx, by = state[:4]
        dx, dy = d
        if (ax, ay) == (bx, by):
            return self.norm((ax + dx, ay + dy), (ax + 2 * dx, ay + 2 * dy))
        ux, uy = bx - ax, by - ay
        if (dx, dy) in ((ux, uy), (-ux, -uy)):
            p1, p2 = ax * dx + ay * dy, bx * dx + by * dy
            head = (ax, ay) if p1 > p2 else (bx, by)
            cell = (head[0] + dx, head[1] + dy)
            return self.norm(cell, cell)
        return self.norm((ax + dx, ay + dy), (bx + dx, by + dy))

    def step(self, state, direction):
        """返回 (result, newstate, info)；result ∈ ok/win/fall/fragile"""
        d = DIR_VEC[direction]
        g = self.geometry(state, d)
        a2, b2 = (g[0], g[1]), (g[2], g[3])
        upright = a2 == b2
        cells = [a2] if upright else [a2, b2]
        teleported = False
        if upright:
            for tp in self.teleports:
                if list(a2) == list(tp["from"]):
                    a2 = b2 = tuple(tp["to"])
                    cells = [a2]
                    teleported = True
                    break

        old_bridges = state[4]
        kinds = [self.support(c, old_bridges) for c in cells]
        if any(k == "void" for k in kinds):
            return "fall", None, {}
        if upright and kinds[0] == "goal":
            return "win", self.norm(a2, b2) + (old_bridges, state[5]), {"teleport": teleported}
        if (not upright) and all(k == "goal" for k in kinds):
            return "fall", None, {}
        if upright and kinds[0] == "fragile":
            return "fragile", None, {}

        pressed = 0
        for i, sw in enumerate(self.switches):
            covered = any(c == (sw["x"], sw["y"]) for c in cells)
            active = covered and (sw["kind"] != "hard" or upright)
            if active:
                pressed |= 1 << i
        bridges = old_bridges
        fired = []
        for i, sw in enumerate(self.switches):
            if ((pressed & ~state[5]) >> i) & 1:
                group = sw["bridge"] - 1
                action = sw.get("action", "open")
                if action == "open":
                    bridges |= 1 << group
                elif action == "close":
                    bridges &= ~(1 << group)
                else:
                    bridges ^= 1 << group
                fired.append(i)
        kinds_after = [self.support(c, bridges) for c in cells]
        if any(k == "void" for k in kinds_after):
            return "fall", None, {}
        newstate = self.norm(a2, b2) + (bridges, pressed)
        return "ok", newstate, {"teleport": teleported, "fired": fired,
                                "bridge": bridges, "cells": cells}


def solve(level, board=None, max_states=500000):
    board = board or Board(level)
    start = board.initial
    queue = deque([start])
    seen = {start: (None, None)}
    goal_state = None
    while queue:
        state = queue.popleft()
        for name, _, _ in DIRS:
            result, nxt, _ = board.step(state, name)
            if result == "win":
                goal_state = (state, name)
                queue.clear()
                break
            if result != "ok" or nxt in seen:
                continue
            seen[nxt] = (state, name)
            queue.append(nxt)
            if len(seen) > max_states:
                return None, len(seen), board
        if goal_state:
            break
    if goal_state is None:
        # 起点本身就在洞里时不算通关
        return None, len(seen), board
    path = []
    cursor, move = goal_state
    path.append(move)
    while seen[cursor][0] is not None:
        prev, m = seen[cursor]
        path.append(m)
        cursor = prev
    path.reverse()
    return path, len(seen), board


def replay(level, board, path):
    state = board.initial
    used_switch = set()
    used_fragile = False
    used_teleport = False
    bridge_changes = 0
    prev_bridges = state[4]
    for m in path:
        result, state, info = board.step(state, m)
        used_switch.update(info.get("fired", []))
        used_teleport |= info.get("teleport", False)
        for c in info.get("cells", []):
            if board.tiles.get(c) == "fragile":
                used_fragile = True
        if state and state[4] != prev_bridges:
            bridge_changes += 1
            prev_bridges = state[4]
    return {"switches": sorted(used_switch), "fragile": used_fragile,
            "teleport": used_teleport, "bridge_changes": bridge_changes}


def report(levels):
    print("=" * 96)
    print("%-3s %-12s %6s %8s %9s %-18s %s" % ("#", "名称", "步数", "状态数", "坠落分支", "解法用到的机关", "最短解"))
    print("=" * 96)
    ok = True
    previous = 0
    for level in levels:
        path, states, board = solve(level)
        if path is None:
            print("%-3s %-12s  !! 无解 (探索 %d 状态)" % (level["id"], level["name"], states))
            ok = False
            continue
        usage = replay(level, board, path)
        problems = []
        if level.get("par") != len(path):
            problems.append("par=%s 应为 %d" % (level.get("par"), len(path)))
        if len(path) < previous:
            problems.append("难度倒退（上一关 %d 步）" % previous)
        if level.get("switches") and not usage["switches"]:
            problems.append("开关形同虚设")
        if level.get("teleports") and not usage["teleport"]:
            problems.append("传送形同虚设")
        previous = len(path)
        falls = 0
        state = board.initial
        for m in path:
            for name, _, _ in DIRS:
                if name != m and board.step(state, name)[0] in ("fall", "fragile"):
                    falls += 1
            state = board.step(state, m)[1] or state
        mech = []
        if usage["switches"]:
            mech.append("开关%s" % usage["switches"])
        if usage["fragile"]:
            mech.append("易碎")
        if usage["teleport"]:
            mech.append("传送")
        if usage["bridge_changes"]:
            mech.append("桥x%d" % usage["bridge_changes"])
        mark = "OK" if not problems else "!!"
        if problems:
            ok = False
        print("%-3s %-12s %s %4d %8d %9d %-18s %s" % (
            level["id"], level["name"], mark, len(path), states, falls,
            ",".join(mech) or "-", "".join(path)))
        if problems:
            print("     ^ " + "；".join(problems))
    print("=" * 96)
    print("校验项：每关可解 / par 等于 BFS 最短步数 / 步数不倒退 / 机关必须被最优解用到")
    return ok


def trace(level):
    path, states, board = solve(level)
    if path is None:
        print("无解")
        return
    state = board.initial
    print("关卡 %s %s  最短 %d 步 / %d 状态" % (level["id"], level["name"], len(path), states))
    for i, m in enumerate(path, 1):
        result, nxt, info = board.step(state, m)
        cells = info.get("cells", [])
        print("%2d %s  %-14s -> %-16s %s" % (
            i, m, str(state[:4]), str(cells),
            ("开关 %s" % info["fired"] if info.get("fired") else "") +
            (" 传送" if info.get("teleport") else "") +
            (" 胜利" if result == "win" else "")))
        state = nxt or state


def probe(level):
    """把终点暂移到每一个可站立的实心格，报告最短步数，用于挑选有挑战的终点。"""
    rows = [r.ljust(max(len(r) for r in level["map"])) for r in level["map"]]
    gy, gx = next((y, x) for y, row in enumerate(rows) for x, c in enumerate(row) if c == "O")
    results = []
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch != "#":
                continue
            trial = dict(level)
            new_rows = [list(r) for r in rows]
            new_rows[gy][gx] = "#"
            new_rows[y][x] = "O"
            trial["map"] = ["".join(r) for r in new_rows]
            path, states, _ = solve(trial)
            if path:
                results.append((len(path), x, y, "".join(path), states, trial))
    results.sort(key=lambda r: (-r[0], r[2], r[1]))
    print("关卡 %s 终点候选（按最短步数降序，共 %d 个可达）:" % (level["name"], len(results)))
    for steps, x, y, path, states, trial in results[:28]:
        path_, _, board = solve(trial)
        usage = replay(trial, board, path_)
        print("  (%2d,%2d) %2d 步  开关%d 传送%s 桥变%d  %s" % (
            x, y, steps, len(usage["switches"]), usage["teleport"],
            usage["bridge_changes"], path))
    print("  --- 最短的 12 个候选 ---")
    for steps, x, y, path, states, trial in results[-12:]:
        print("  (%2d,%2d) %2d 步  %s" % (x, y, steps, path))


def main():
    levels = load_levels()
    args = sys.argv[1:]
    if not args:
        return 0 if report(levels) else 1
    if args[0] == "--trace":
        trace(levels[int(args[1]) - 1])
        return 0
    if args[0] == "--probe":
        probe(levels[int(args[1]) - 1])
        return 0
    if args[0] == "--goal":
        level = dict(levels[int(args[1]) - 1])
        x, y = int(args[2]), int(args[3])
        rows = [list(r.ljust(max(len(r) for r in level["map"]))) for r in level["map"]]
        for row in rows:
            for i, c in enumerate(row):
                if c == "O":
                    row[i] = "#"
        rows[y][x] = "O"
        level["map"] = ["".join(r) for r in rows]
        trace(level)
        return 0
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main())
