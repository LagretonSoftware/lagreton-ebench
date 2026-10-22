"""Check the switch's decisions without a board. Run: uv run python tests/test_switch.py"""

import sys
import tempfile
from pathlib import Path


def test_scan_reads_only_the_bootloader():
    from ebench import switch
    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp)
        (folder / "boot.bin").write_bytes(b"\xe9" + bytes(100) + b"I (%lu) boot: Checking flash encryption..." + bytes(50))
        (folder / "clean.bin").write_bytes(b"\xe9" + bytes(100) + b"Image requires efuse blk rev >= v%lu" + bytes(50))
        app_strings = b"\xe9" + bytes(0x9000) + b"flash encrypted write length must be multiple of 16"
        (folder / "merged.bin").write_bytes(app_strings)  # driver text in the app, past the bootloader
        part = lambda f, at=0: {"name": "Bootloader", "address": at, "file": f, "size": 0}
        assert switch.scan(folder, {"parts": [part("boot.bin")]}), "lockout bootloader not caught"
        assert not switch.scan(folder, {"parts": [part("clean.bin")]})
        assert not switch.scan(folder, {"parts": [part("merged.bin")]}), "app text flagged"
        assert not switch.scan(folder, {"parts": [part("boot.bin", 0x20000)]}), "an app slot isn't a bootloader"


def test_wipe_regions():
    from ebench import switch
    board_nvs = {"nvs": {"offset": 0x9000, "size": 0x6000}}
    table = [{"subtype": "nvs", "offset": 0x9000, "size": 0x7000}, {"subtype": "otadata", "offset": 0x10000, "size": 0x2000}]
    merged = {"nvs": {"offset": 0x9000, "size": 0x7000}, "table": table,
              "parts": [{"address": 0, "size": 0x300000}]}
    assert switch.wipe_regions(board_nvs, merged) == [(0x9000, 0x6000), (0x9000, 0x7000)]
    loose = {**merged, "parts": [{"address": 0, "size": 0x5000}, {"address": 0x20000, "size": 0x100000}]}
    assert (0x10000, 0x2000) in switch.wipe_regions(board_nvs, loose), "stale boot-slot data left behind"
    assert switch.wipe_regions({}, {"parts": []}) == []


def test_settings_for_picks_the_newest_matching_save():
    from ebench import board, switch
    saves = [
        {"id": "c", "kind": "settings", "firmware": {"project": "other"}, "offset": 0x9000, "size": 0x6000},
        {"id": "b", "kind": "settings", "firmware": {"project": "fw"}, "offset": 0x9000, "size": 0x6000},
        {"id": "a", "kind": "settings", "firmware": {"project": "fw"}, "offset": 0x9000, "size": 0x5000},
        {"id": "z", "kind": "full", "firmware": {"project": "fw"}},
    ]
    board.listing = lambda mac: saves  # newest first, like the real one
    plan = {"app": {"project": "fw"}, "nvs": {"offset": 0x9000, "size": 0x6000}}
    assert switch.settings_for({"mac": "x"}, plan)["id"] == "b"
    assert switch.settings_for({"mac": "x"}, {**plan, "nvs": {"offset": 0x9000, "size": 0x7000}}) is None, "wrong-size save restored"
    assert switch.settings_for({"mac": "x"}, {**plan, "app": None}) is None


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    test_scan_reads_only_the_bootloader()
    test_wipe_regions()
    test_settings_for_picks_the_newest_matching_save()
    print("ok: scan, wipe regions, settings restore choice")
