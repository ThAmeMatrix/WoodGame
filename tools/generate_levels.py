#!/usr/bin/env python3
"""程序化生成追加关卡：随机浮岛链 + 吊桥/开关/传送，逐关用 BFS 证明可解且机关必需。

  python -X utf8 tools/generate_levels.py --dry-run          只统计候选分布
  python -X utf8 tools/generate_levels.py --count 100       生成 100 关并写回 src/levels.js

生成结果可复现（固定随机种子），且写回是幂等的：每次都保留 id<=19 的主线关卡，
只替换之后的挑战关。关卡数据区始终严格保持 JSON 语法。
"""
import argparse
import json
import random
import sys
import time
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from verify_levels import solve, replay  # noqa: E402

SEED = 20261109
MAIN_COUNT = 19
MIN_PAR = 26
MAX_STATES = 80000

NAME_A = ["灰", "青", "赤", "霜", "暮", "星", "砂", "隐", "裂", "回",
          "双", "孤", "深", "断", "折", "旋", "静", "逆", "残", "沉",
          "空", "远", "寒", "旧", "碎", "长", "浮", "晚", "素", "幽"]
NAME_B = ["廊", "桥", "阶", "环", "隙", "塔", "径", "门", "屿", "梁",
          "格", "阵", "港", "窗", "谷", "道", "关", "台", "岸", "屏"]
CHAPTERS = ["远征 I", "远征 II", "远征 III", "远征 IV", "远征 V",
            "远征 VI", "远征 VII", "远征 VIII", "远征 IX", "远征 X"]
TIPS = [
    "先定好每座桥的开关顺序，再用撤销键回退试错。",
    "把每个岛当成一站：先想清楚要立在哪一格，再倒推路线。",
    "按 H 可以看到当前局面通往终点的最优下一步。",
    "坠落不计步，但会打乱开关的按压次数，留意往复开关。",
    "横躺沿长边一翻就立起来；朝侧面翻只挪一格，用来对齐洞口。"
]


def make_islands(rng):
    """构造一串浮岛，返回网格、岛的 x 范围、有效行范围与分段信息。"""
    n = rng.randint(3, 5)
    widths = [rng.randint(3, 6) for _ in range(n)]
    gaps = [rng.randint(2, 3) for _ in range(n - 1)]
    h = rng.randint(5, 8)
    tops = [rng.randint(0, 1) for _ in range(n)]
    bots = [rng.randint(0, 1) for _ in range(n)]
    brow = rng.randint(max(tops), h - 1 - max(bots))

    xs = []
    x = 0
    for i in range(n):
        xs.append(x)
        x += widths[i]
        if i < n - 1:
            x += gaps[i]
    w = x
    grid = [[" "] * w for _ in range(h)]
    for i in range(n):
        for y in range(tops[i], h - bots[i]):
            for xx in range(xs[i], xs[i] + widths[i]):
                grid[y][xx] = "#"

    # 最后一段用传送台代替吊桥，制造路线变化
    last_teleport = rng.random() < 0.28
    bridge_segments = n - 2 if last_teleport else n - 1
    for i in range(bridge_segments):
        bx = xs[i] + widths[i]
        for xx in range(bx, bx + gaps[i]):
            grid[brow][xx] = str(i + 1)

    return grid, xs, widths, tops, bots, h, brow, n, bridge_segments, last_teleport


def make_level(rng):
    grid, xs, widths, tops, bots, h, brow, n, bridge_segments, last_teleport = make_islands(rng)
    w = len(grid[0])

    # 起点：第一个岛左上角
    sx, sy = xs[0], tops[0]
    grid[sy][sx] = "S"

    # 每座桥由它上游那座岛里的一枚开关控制
    switch_kinds = []
    for i in range(bridge_segments):
        kind = rng.choice("oxt")
        iy = rng.randint(tops[i], h - bots[i] - 1)
        ix = rng.randint(xs[i], xs[i] + widths[i] - 1)
        if grid[iy][ix] == "S":
            continue
        grid[iy][ix] = kind
        switch_kinds.append(kind)

    # 传送段：从倒数第二座岛送到最后一座岛
    teleports = []
    if last_teleport:
        fy = rng.randint(tops[n - 2], h - bots[n - 2] - 1)
        fx = rng.randint(xs[n - 2], xs[n - 2] + widths[n - 2] - 1)
        ty = rng.randint(tops[n - 1], h - bots[n - 1] - 1)
        tx = rng.randint(xs[n - 1], xs[n - 1] + widths[n - 1] - 1)
        teleports.append({"from": [fx, fy], "to": [tx, ty]})

    # 岛内挖 0~3 个缺口，制造需要规划的形状（避开起点/开关/桥行）
    for _ in range(rng.randint(0, 3)):
        i = rng.randrange(n)
        gy = rng.randint(tops[i], h - bots[i] - 1)
        gx = rng.randint(xs[i], xs[i] + widths[i] - 1)
        if gy == brow or grid[gy][gx] != "#":
            continue
        grid[gy][gx] = " "

    # 少量易碎木：在中间某座岛铺两行，迫使玩家保持横躺
    fragile = rng.random() < 0.22 and h >= 6
    if fragile:
        i = rng.randrange(1, n - 1)
        fy = rng.randint(tops[i] + 1, h - bots[i] - 2)
        for xx in range(xs[i], xs[i] + widths[i]):
            if grid[fy][xx] == "#":
                grid[fy][xx] = "~"
            if fy + 1 < h - bots[i] and grid[fy + 1][xx] == "#":
                grid[fy + 1][xx] = "~"

    # 终点洞：最后一座岛内随机一格
    oy = rng.randint(tops[-1], h - bots[-1] - 1)
    ox = rng.randint(xs[-1], xs[-1] + widths[-1] - 1)
    if grid[oy][ox] == " ":
        grid[oy][ox] = "#"
    grid[oy][ox] = "O"

    # switches 数组按「从上到下、从左到右」扫描顺序，与 rules.js / 验证器一致
    found = []
    for y in range(h):
        for x in range(w):
            if grid[y][x] in "oxt":
                owner = max(i for i in range(n) if xs[i] <= x < xs[i] + widths[i])
                found.append((x, y, grid[y][x], owner))
    switches = []
    for x, y, kind, owner in found:
        group = min(owner + 1, bridge_segments)
        if group < 1:
            continue
        switches.append({"bridge": group,
                         "action": "toggle" if kind == "t" else "open"})

    return {
        "map": ["".join(row) for row in grid],
        "orient": "upright",
        "bridges": [False] * bridge_segments,
        "switches": switches,
        "teleports": teleports,
    }


def check(level):
    """BFS 证明可解，且每类机关都被最优解用到；返回最短步数。"""
    try:
        path, states, board = solve(level, max_states=MAX_STATES)
    except (SystemExit, RecursionError):
        return None
    if not path:
        return None
    usage = replay(level, board, path)
    if level["switches"] and not usage["switches"]:
        return None
    if level["teleports"] and not usage["teleport"]:
        return None
    if any("~" in row for row in level["map"]) and not usage["fragile"]:
        return None
    if len(level["map"]) * max(len(r) for r in level["map"]) > 260:
        return None
    return len(path)


def describe(level, rng):
    chars = "".join(level["map"])
    bridges = len(level["bridges"])
    bits = []
    if bridges:
        bits.append("%d 座吊桥串起 %d 片浮岛" % (bridges, bridges + 1))
    if level["teleports"]:
        bits.append("裂谷尽头有传送台")
    if "~" in chars:
        bits.append("其中一段薄木撑不住竖立")
    if "x" in chars:
        bits.append("X 重开关必须整块立着压")
    if "t" in chars:
        bits.append("菱形开关压一次反转一次桥")
    if "o" in chars:
        bits.append("圆形软开关任意触压即开桥")
    if not bits:
        bits.append("又一片需要绕行的浮岛")
    return "远征路段：" + "，".join(bits) + "。", rng.choice(TIPS)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=100)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--tries", type=int, default=9000)
    ap.add_argument("--seconds", type=float, default=420)
    args = ap.parse_args()

    rng = random.Random(SEED)
    start = time.time()
    buckets = defaultdict(list)
    tries = 0
    accepted = 0
    while tries < args.tries and accepted < args.count * 4 and time.time() - start < args.seconds:
        tries += 1
        level = make_level(rng)
        par = check(level)
        if par is None or par < MIN_PAR:
            continue
        # 去重：同一张地图只留一次
        sig = "\n".join(level["map"])
        if any(sig == "\n".join(v["map"]) for v in buckets[par]):
            continue
        buckets[par].append(level)
        accepted += 1

    print("尝试 %d 次，合格候选 %d 个，耗时 %.1fs" %
          (tries, accepted, time.time() - start))
    print("par 分布：", {p: len(v) for p, v in sorted(buckets.items())})
    if args.dry_run:
        return 0 if accepted >= args.count else 1

    # 全部合格候选按 par 升序排列后均匀抽样：既保证难度不倒退，也让关卡覆盖整个难度区间
    all_cands = []
    for par in sorted(buckets):
        pool = buckets[par][:]
        random.Random(SEED + par).shuffle(pool)
        all_cands.extend((par, lv) for lv in pool)
    if len(all_cands) < args.count:
        print("!! 候选不足，只有 %d 个" % len(all_cands))
        return 1
    step = len(all_cands) / args.count
    selected = [all_cands[min(len(all_cands) - 1, int(i * step))] for i in range(args.count)]

    names = rng.sample([a + b for a in NAME_A for b in NAME_B], args.count)
    levels = load_main()
    for i, (par, lv) in enumerate(selected):
        intro, tip = describe(lv, rng)
        levels.append({
            "id": MAIN_COUNT + i + 1,
            "name": names[i],
            "chapter": CHAPTERS[min(i // 10, len(CHAPTERS) - 1)],
            "intro": intro,
            "tip": tip,
            "map": lv["map"],
            "orient": lv["orient"],
            "bridges": lv["bridges"],
            "switches": lv["switches"],
            "teleports": lv["teleports"],
            "par": par,
        })
    write_levels(levels)
    print("写入 %d 关（总 %d 关），par %d → %d" %
          (len(selected), len(levels), selected[0][0], selected[-1][0]))
    return 0


def load_main():
    text = (ROOT / "src" / "levels.js").read_text(encoding="utf-8")
    payload = text.split("/*DATA*/", 1)[1].split("/*ENDDATA*/", 1)[0]
    payload = payload[payload.index("=") + 1:].strip().rstrip(";")
    data = json.loads(payload)
    return [lv for lv in data if lv["id"] <= MAIN_COUNT]


def write_levels(levels):
    path = ROOT / "src" / "levels.js"
    text = path.read_text(encoding="utf-8")
    head, rest = text.split("/*DATA*/", 1)
    data_block, tail = rest.split("/*ENDDATA*/", 1)
    close = data_block.rfind("];")
    prefix = data_block[:close]
    new_items = [json.dumps(lv, ensure_ascii=False, indent=4) for lv in levels[MAIN_COUNT:]]
    body = ",\n".join("    " + item.replace("\n", "\n    ") for item in new_items)
    rebuilt = prefix.rstrip() + ",\n" + body + "\n];\n"
    path.write_text(head + "/*DATA*/" + rebuilt + "/*ENDDATA*/" + tail, encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
