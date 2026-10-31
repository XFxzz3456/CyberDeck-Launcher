"""Write a demo state for native screenshots. Never shipped with the app."""

import json
import os
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(r"D:\ncl")
GAME = ROOT / "TestGame"
DATA = ROOT / "src-tauri" / "target" / "debug" / "cyberdeck-data"
STAGING = DATA / "staging"

for path in [GAME / "bin" / "x64", DATA]:
    path.mkdir(parents=True, exist_ok=True)
(GAME / "bin" / "x64" / "Cyberpunk2077.exe").write_bytes(b"MZ fake")
(GAME / "archive" / "pc" / "mod").mkdir(parents=True, exist_ok=True)
(GAME / "r6" / "config").mkdir(parents=True, exist_ok=True)

now = datetime.now()


def iso(days: int) -> str:
    return (now - timedelta(days=days)).isoformat() + "Z"


def deployed(mod_id: str, rel: str, index: int = 0):
    return {
        "source": str(STAGING / mod_id / "payload" / f"file-{index}"),
        "target": str(GAME / rel.replace("/", "\\")),
        "linkType": "hardLink",
        "relativePath": rel,
    }


def mod(
    mod_id,
    name,
    category,
    layout,
    enabled,
    version="1.0.0",
    author="CyberDeck",
    desc="",
    size=12_400_000,
    files=4,
    folder=None,
    deployed_files=None,
    warnings=None,
):
    return {
        "id": mod_id,
        "name": name,
        "version": version,
        "author": author,
        "category": category,
        "description": desc,
        "sourceZip": None,
        "stagingPath": str(STAGING / mod_id / "payload"),
        "coverPath": None,
        "enabled": enabled,
        "installedAt": iso(8),
        "updatedAt": iso(1),
        "sizeBytes": size,
        "fileCount": files,
        "layout": layout,
        "modFolder": folder,
        "warnings": warnings or [],
        "deployedFiles": deployed_files or [],
        "hasArchive": layout in ("archive", "gameRoot"),
        "hasRedmod": layout == "redmod",
        "hasCet": layout == "cet",
    }


mods = [
    mod("mod-red4ext", "RED4ext", "框架", "redmod", True, "1.27.0", "WopsS",
        "现代 Cyberpunk 脚本扩展的运行时底座。", 8_912_000, 24, "RED4ext"),
    mod("mod-cet", "Cyber Engine Tweaks", "框架", "cet", True, "1.36.1", "Yamashi",
        "CET 控制台与 Lua 模组运行时。", 24_620_000, 61, "Cyber Engine Tweaks"),
    mod("mod-archivexl", "ArchiveXL", "框架", "redmod", True, "1.23.4", "psiberx",
        "扩展 archive 加载与流式资源能力。", 5_102_000, 12, "ArchiveXL"),
    mod("mod-tweakxl", "TweakXL", "框架", "redmod", True, "1.12.2", "psiberx",
        "TweakDB 修改框架。", 4_211_000, 9, "TweakXL"),
    mod("mod-relit", "CyberDeck ReLIT", "视觉", "archive", True, "2.4.0", "Skyline",
        "重做夜间光照、湿地面反射与霓虹溢出。", 186_500_000, 3,
        deployed_files=[deployed("mod-relit", "archive/pc/mod/zzz_relit_core.archive"),
                        deployed("mod-relit", "archive/pc/mod/zzz_relit_lut.archive", 1),
                        deployed("mod-relit", "archive/pc/mod/zzz_relit.xl", 2)]),
    mod("mod-neonrain", "Neon Rain ReShade", "视觉", "archive", True, "1.8.1", "V",
        "轻量 ReShade 预设：冷青阴影、暖黄高光。", 62_200_000, 2,
        deployed_files=[deployed("mod-neonrain", "archive/pc/mod/zzz_relit_core.archive"),
                        deployed("mod-neonrain", "archive/pc/mod/zzz_neonrain.xl", 1)],
        warnings=["与 CyberDeck ReLIT 写入了同一个 archive，二者只能启用一个。"]),
    mod("mod-streetstyle", "Street Style Vol. 3", "服装", "archive", True, "3.0.2", "Kala",
        "42 套街头服装，包含 ArchiveXL 变体与动态材质。", 1_240_000_000, 3,
        deployed_files=[deployed("mod-streetstyle", "archive/pc/mod/streetstyle_vol3.archive"),
                        deployed("mod-streetstyle", "archive/pc/mod/streetstyle_vol3.xl", 1)]),
    mod("mod-chromearms", "Cyberarms — Chrome Collection", "武器", "redmod", True, "1.3.0", "Rogue",
        "为螳螂刀与单分子线增加 18 种镀铬变体。", 74_000_000, 18, "ChromeArms",
        deployed_files=[deployed("mod-chromearms", "mods/ChromeArms/info.json"),
                        deployed("mod-chromearms", "mods/ChromeArms/archives/chromearms.archive", 1)]),
    mod("mod-caliburn", "Rayfield Caliburn — Blackout", "车辆", "archive", True, "1.1.0", "Merc",
        "哑光黑车漆、去标与定制轮毂。", 38_600_000, 1,
        deployed_files=[deployed("mod-caliburn", "archive/pc/mod/caliburn_blackout.archive")]),
    mod("mod-fixers", "Immersive Fixers", "任务", "cet", True, "1.6.5", "Dez",
        "让中间人委托更有存在感。", 3_900_000, 14, "ImmersiveFixers",
        deployed_files=[deployed("mod-fixers", "bin/x64/plugins/cyber_engine_tweaks/mods/ImmersiveFixers/init.lua")]),
    mod("mod-handling", "Better Vehicle Handling", "玩法", "redmod", False, "0.9.4", "Dex",
        "重新调校所有车辆的抓地力与悬挂。", 1_200_000, 6, "BetterVehicleHandling"),
    mod("mod-radio", "Radio Extender", "音频", "cet", True, "2.2.0", "Ula",
        "向游戏内电台添加自定义曲目与新频道。", 8_800_000, 22, "RadioExtender",
        deployed_files=[deployed("mod-radio", "bin/x64/plugins/cyber_engine_tweaks/mods/RadioExtender/init.lua")]),
    mod("mod-photomode", "Photo Mode Unlocker", "工具", "redscript", False, "1.4.0", "Nova",
        "解锁拍照模式的相机距离与 NPC 姿势限制。", 780_000, 2, "PhotoModeUnlocker"),
    mod("mod-dogtown", "Dogtown Vibes", "视觉", "archive", False, "1.0.3", "Barghest",
        "为狗镇增加沙尘、警示灯与更密集的空中交通。", 91_000_000, 2),
    mod("mod-hardcore", "Hardcore 2077", "玩法", "redmod", False, "0.7.1", "Blackwall",
        "重做伤害、护甲与治疗物品。", 6_100_000, 11, "Hardcore2077"),
    mod("mod-cyberdeck", "Arasaka Cyberdeck", "武器", "archive", False, "1.2.0", "Hanako",
        "新增三款高层级网络接入仓。", 22_000_000, 1),
]

state = {
    "schemaVersion": 1,
    "gameDir": str(GAME),
    "stagingDir": str(STAGING),
    "mods": mods,
    "loadOrder": [
        "archive/pc/mod/zzz_relit_core.archive",
        "archive/pc/mod/zzz_relit_lut.archive",
        "archive/pc/mod/streetstyle_vol3.archive",
        "archive/pc/mod/caliburn_blackout.archive",
    ],
    "settings": {
        "writeModlist": False,
        "autoBackup": True,
        "confirmUninstall": True,
        "launchMethod": "auto",
    },
    "lastGameVersion": "2.31",
    "lastLaunch": iso(1),
    "backup": {
        "id": "snapshot-demo",
        "createdAt": iso(6),
        "root": str(DATA / "backups" / "snapshot-demo"),
        "gameDir": str(GAME),
        "files": ["archive/pc/mod/modlist.txt", "r6/config/settings/UserSettings.json"],
    },
}

(DATA / "launcher-state.json").write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
print(DATA / "launcher-state.json")
