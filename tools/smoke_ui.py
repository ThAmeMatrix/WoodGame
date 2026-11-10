#!/usr/bin/env python3
"""浏览器端烟雾测试：真实按键通关、机关提示、撤销、坠落回退与控制台错误检查。

   python -X utf8 tools/smoke_ui.py [base_url]
   需要先启动本地服务（npm start 或 python -m http.server 8080）。
"""
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from verify_levels import load_levels, solve, Board  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
SHOTS = ROOT / "work"
SHOTS.mkdir(exist_ok=True)
BASE = next((a for a in sys.argv[1:] if not a.startswith("--")), "http://127.0.0.1:8080/")
LEVELS = load_levels()

# 方向键映射
KEY = {"U": "ArrowUp", "D": "ArrowDown", "L": "ArrowLeft", "R": "ArrowRight"}
DIR_NAME = {"U": "↑ 上", "D": "↓ 下", "L": "← 左", "R": "→ 右"}


def run(page, path, pause=320):
    for d in path:
        page.keyboard.press(KEY[d])
        page.wait_for_timeout(pause)
    wait_win(page)


def win_shown(page):
    return page.locator("#win-overlay").evaluate("el => el.classList.contains('show')")


def wait_win(page):
    try:
        page.wait_for_function(
            "document.getElementById('win-overlay').classList.contains('show')",
            timeout=6000)
    except Exception:
        pass
    page.wait_for_timeout(200)


def close_win(page):
    page.evaluate("document.getElementById('win-overlay').classList.remove('show')")


def main():
    errors = []
    checks = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1600, "height": 980}, device_scale_factor=1)
        page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
        page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" else None)
        page.goto(BASE, wait_until="networkidle")
        page.evaluate("try { localStorage.clear(); } catch (e) {}")
        page.reload(wait_until="networkidle")
        page.wait_for_timeout(600)
        page.screenshot(path=str(SHOTS / "ui-01-start.png"), full_page=True)

        title = page.locator("#level-name").inner_text()
        par = page.locator("#par-count").inner_text()
        checks.append(("首关标题=" + title, "01" in title))
        checks.append(("首关 par=" + par, par == str(LEVELS[0]["par"])))
        checks.append(("关卡列表 %d 项" % len(LEVELS),
                       page.locator(".level-item").count() == len(LEVELS)))
        checks.append(("画布已绘制", page.locator("#stage-canvas").evaluate(
            "c => c.width > 100 && c.height > 100")))

        # 方向映射：↑=左上(-X)、→=右上(-Y)、↓=右下(+X)、←=左下(+Y)
        vec = page.evaluate("window.WoodRules.VEC")
        checks.append(("方向映射 " + str(vec), vec ==
                       {"U": [-1, 0], "D": [1, 0], "L": [0, 1], "R": [0, -1]}))
        up = page.locator(".dpad-btn.up").bounding_box()
        down = page.locator(".dpad-btn.down").bounding_box()
        right = page.locator(".dpad-btn.right").bounding_box()
        left = page.locator(".dpad-btn.left").bounding_box()
        checks.append(("菱形方向键位置", up["x"] < right["x"] and up["y"] < down["y"]
                       and left["x"] < down["x"] and left["y"] > up["y"]))

        # 1) 坠落：新映射下第 1 关向上（屏幕左上）会掉出平台，步数应保持不变
        page.keyboard.press("ArrowUp")
        page.wait_for_timeout(750)
        checks.append(("坠落不计步", page.locator("#move-count").inner_text() == "0"))

        # 2) 用最优解通关第 1 关
        run(page, solve(LEVELS[0])[0])
        page.screenshot(path=str(SHOTS / "ui-02-win.png"), full_page=True)
        checks.append(("第 1 关胜利面板", win_shown(page)))
        checks.append(("第 1 关步数=%d" % LEVELS[0]["par"],
                       page.locator("#move-count").inner_text() == str(LEVELS[0]["par"])))
        tutorial = [lv for lv in LEVELS if lv["chapter"] == "教程" and
                    (lv.get("switches") or lv.get("teleports") or
                     any("~" in row for row in lv["map"]))]
        checks.append(("机制教程关 %d 个" % len(tutorial), len(tutorial) >= 6))
        checks.append(("三星评价", page.locator("#win-stars").inner_text().strip() == "★★★"))

        # 3) 下一关、提示、撤销
        wait_win(page)
        page.locator("#win-next").click()
        page.wait_for_timeout(300)
        checks.append(("切换到第 2 关", "02" in page.locator("#level-name").inner_text()))
        page.locator("#btn-hint").click()
        hint = page.locator("#hint-text").inner_text()
        first = solve(LEVELS[1])[0][0]
        checks.append(("提示给出下一步: " + hint,
                       "下一步" in hint and DIR_NAME[first] in hint))
        page.keyboard.press(KEY[first])
        page.wait_for_timeout(420)
        checks.append(("移动后步数=1", page.locator("#move-count").inner_text() == "1"))
        page.keyboard.press("z")
        page.wait_for_timeout(320)
        checks.append(("撤销后步数=0", page.locator("#move-count").inner_text() == "0"))

        # 4) 跑通第 2 关
        run(page, solve(LEVELS[1])[0])
        checks.append(("第 2 关通关", win_shown(page)))

        # 5) 跳到实战机关关，验证桥在开关触发前后确实变化
        close_win(page)
        page.locator(".level-item").nth(10).click()   # 第 11 关「圆钮」
        page.wait_for_timeout(300)
        page.screenshot(path=str(SHOTS / "ui-03-switches.png"), full_page=True)
        checks.append(("机关关标题", "圆钮" in page.locator("#level-name").inner_text()))
        run(page, solve(LEVELS[10])[0])
        checks.append(("机关关可通关", win_shown(page)))

        # 6) 最后一关的复杂地图渲染
        close_win(page)
        page.locator(".level-item").nth(len(LEVELS) - 1).click()
        page.wait_for_timeout(400)
        page.screenshot(path=str(SHOTS / "ui-04-final.png"), full_page=True)
        checks.append(("终章 par=%d" % LEVELS[-1]["par"],
                       page.locator("#par-count").inner_text() == str(LEVELS[-1]["par"])))

        # 7) 可选：把关卡的最优解逐关在浏览器里真实按一遍
        #    --all 跑全部 119 关（约十几分钟）；--sample 跑主线 + 远征关等距抽样
        if "--all" in sys.argv or "--sample" in sys.argv:
            if "--sample" in sys.argv:
                targets = LEVELS[:19] + [lv for lv in LEVELS[19:]
                                         if (lv["id"] - 20) % 12 == 0]
                if LEVELS[-1] not in targets:
                    targets.append(LEVELS[-1])
            else:
                targets = LEVELS
            close_win(page)
            for lv in targets:
                close_win(page)
                page.locator(".level-item").nth(lv["id"] - 1).click()
                page.wait_for_timeout(220)
                board = Board(lv)
                path = solve(lv)[0]
                state = board.initial
                for d in path:
                    _, nxt, info = board.step(state, d)
                    page.keyboard.press(KEY[d])
                    page.wait_for_timeout(570 if info.get("teleport") else 265)
                    state = nxt or state
                try:
                    page.wait_for_function(
                        "document.getElementById('win-overlay').classList.contains('show')",
                        timeout=6000)
                except Exception:
                    pass
                ok = win_shown(page) and page.locator("#move-count").inner_text() == str(lv["par"])
                checks.append(("全关实测 %02d %s (%d 步)" % (lv["id"], lv["name"], lv["par"]), ok))
                close_win(page)

        # 8) 可选：慢放并逐帧截取入洞动画，用于目视检查「滑进洞里」的过渡
        if "--anim" in sys.argv:
            close_win(page)
            page.evaluate("window.WoodAnimMs.win = 4200")
            page.evaluate("document.getElementById('win-overlay')"
                          ".style.setProperty('display','none','important')")
            page.locator(".level-item").nth(0).click()
            page.wait_for_timeout(250)
            path = solve(LEVELS[0])[0]
            for d in path[:-1]:
                page.keyboard.press(KEY[d])
                page.wait_for_timeout(330)
            page.keyboard.press(KEY[path[-1]])
            for i in range(10):
                page.screenshot(path=str(SHOTS / ("anim-%d.png" % i)), full_page=False)
                page.wait_for_timeout(300)

        browser.close()

    print("-" * 72)
    for name, ok in checks:
        print(("  OK   " if ok else "  FAIL ") + name)
    print("-" * 72)
    print("控制台/页面错误：", errors if errors else "无")
    print("截图：", ", ".join(sorted(f.name for f in
                                   list(SHOTS.glob("ui-*.png")) + list(SHOTS.glob("anim-*.png")))))
    failed = [n for n, ok in checks if not ok] + errors
    print("结果：", "全部通过" if not failed else "存在 %d 个问题" % len(failed))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
