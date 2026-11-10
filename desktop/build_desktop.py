#!/usr/bin/env python3
"""构建 Windows 桌面单文件应用：同步游戏资源 → 生成图标 → PyInstaller 打包 → dist/WoodGame.exe

  python -X utf8 desktop/build_desktop.py
"""
import hashlib
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / "desktop"
GAME = DESKTOP / "game"
DIST = ROOT / "dist"
ICON = DESKTOP / "woodgame.ico"
EXE = DIST / "WoodGame.exe"


def make_icon():
    from PIL import Image, ImageDraw
    size = 256
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([8, 8, 248, 248], radius=54, fill=(19, 27, 36, 255))
    d.rounded_rectangle([8, 8, 248, 248], radius=54, outline=(74, 96, 114, 255), width=2)

    cx, cy, half_w, half_h, height = 128, 88, 84, 42, 76
    top = (cx, cy - half_h)
    right = (cx + half_w, cy)
    bottom = (cx, cy + half_h)
    left = (cx - half_w, cy)
    d.polygon([left, bottom, (bottom[0], bottom[1] + height), (left[0], left[1] + height)],
              fill=(145, 94, 49, 255))
    d.polygon([bottom, right, (right[0], right[1] + height), (bottom[0], bottom[1] + height)],
              fill=(190, 133, 76, 255))
    d.polygon([top, right, bottom, left], fill=(240, 206, 150, 255))
    outline = (72, 44, 20, 255)
    d.line([top, right, bottom, left, top], fill=outline, width=3, joint="curve")
    d.line([left, (left[0], left[1] + height), (bottom[0], bottom[1] + height), bottom],
           fill=outline, width=3, joint="curve")
    d.line([bottom, (bottom[0], bottom[1] + height), (right[0], right[1] + height), right],
           fill=outline, width=3, joint="curve")
    d.line([bottom, (bottom[0], bottom[1] + height)], fill=outline, width=3)
    for k in range(1, 4):
        t = k / 4
        a = (top[0] * (1 - t) + left[0] * t, top[1] * (1 - t) + left[1] * t)
        b = (right[0] * (1 - t) + bottom[0] * t, right[1] * (1 - t) + bottom[1] * t)
        d.line([a, b], fill=(186, 133, 72, 255), width=3)

    im.save(ICON, format="ICO",
            sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    return ICON


def sync_game():
    if GAME.exists():
        shutil.rmtree(GAME)
    (GAME / "src").mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / "index.html", GAME / "index.html")
    shutil.copy2(ROOT / "styles.css", GAME / "styles.css")
    count = 2
    for src in sorted((ROOT / "src").glob("*.js")):
        shutil.copy2(src, GAME / "src" / src.name)
        count += 1
    return count


def main():
    files = sync_game()
    icon = make_icon()
    DIST.mkdir(exist_ok=True)
    print("资源同步 %d 个文件，图标 %s" % (files, icon.name))

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean", "--onefile", "--noconsole",
        "--name", "WoodGame",
        "--icon", str(icon),
        "--add-data", str(GAME) + ";game",
        "--distpath", str(DIST),
        "--workpath", str(DESKTOP / "build"),
        "--specpath", str(DESKTOP),
        str(DESKTOP / "launcher.py"),
    ]
    print("打包中（PyInstaller onefile）...")
    result = subprocess.run(cmd, cwd=str(DESKTOP))
    if result.returncode != 0:
        print("!! PyInstaller 失败", result.returncode)
        return result.returncode
    if not EXE.is_file():
        print("!! 未找到产物", EXE)
        return 1
    digest = hashlib.sha256(EXE.read_bytes()).hexdigest()
    print("产物：%s  %.2f MB" % (EXE, EXE.stat().st_size / 1024 / 1024))
    print("SHA256：%s" % digest)

    archive = DIST / "WoodGame-Windows-x64.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(EXE, arcname="WoodGame.exe")
    print("分发包：%s  %.2f MB" % (archive, archive.stat().st_size / 1024 / 1024))
    return 0


if __name__ == "__main__":
    sys.exit(main())
