"""滚木归位 · Windows 桌面启动器

把内嵌的游戏资源同步到一个固定目录（保证 file:// 的 localStorage 稳定、通关进度不丢），
再用 Edge / Chrome 的 --app 模式打开一个无地址栏的独立窗口。

  WoodGame.exe              正常启动
  WoodGame.exe --selftest   只做自检并写出 %LOCALAPPDATA%\\WoodGame\\selftest.json，不打开窗口
"""
import json
import os
import shutil
import subprocess
import sys
import winreg
from pathlib import Path

APP_NAME = "WoodGame"
VERSION = "1.1.0"


def resource_dir():
    base = getattr(sys, "_MEIPASS", None)
    if base:
        return Path(base) / "game"
    return Path(__file__).resolve().parent / "game"


def app_dir():
    local = os.environ.get("LOCALAPPDATA")
    base = Path(local) if local else Path.home() / "AppData" / "Local"
    return base / APP_NAME


def sync_game():
    """每次启动覆盖同步，文件总量很小；固定路径让 file:// 的存档 origin 保持不变。"""
    src = resource_dir()
    dst = app_dir() / "app"
    dst.mkdir(parents=True, exist_ok=True)
    count = 0
    for item in src.rglob("*"):
        if not item.is_file():
            continue
        out = dst / item.relative_to(src)
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(item, out)
        count += 1
    return dst / "index.html", count


def find_browser():
    candidates = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    ]
    for p in candidates:
        if p and Path(p).is_file():
            return p
    for root, sub in ((winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe"),
                      (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe")):
        try:
            with winreg.OpenKey(root, sub) as key:
                value = winreg.QueryValue(key, "")
                if value and Path(value).is_file():
                    return value
        except OSError:
            pass
    return None


def main():
    index, count = sync_game()
    browser = find_browser()
    info = {
        "version": VERSION,
        "resources": str(resource_dir()),
        "installed": str(index),
        "index_exists": index.is_file(),
        "files_synced": count,
        "browser": browser,
        "profile": str(app_dir() / "profile"),
    }

    if "--selftest" in sys.argv:
        target = app_dir() / "selftest.json"
        target.write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
        return 0

    if browser:
        profile = app_dir() / "profile"
        profile.mkdir(parents=True, exist_ok=True)
        args = [
            browser,
            "--app=" + index.as_uri(),
            "--window-size=1400,940",
            "--window-position=80,40",
            "--user-data-dir=" + str(profile),
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
        ]
        subprocess.Popen(args, close_fds=True)
    else:
        # 没有 Edge / Chrome 时退回默认浏览器，至少能正常游玩
        os.startfile(str(index))
    return 0


if __name__ == "__main__":
    sys.exit(main())
