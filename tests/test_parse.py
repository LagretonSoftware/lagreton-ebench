"""Check the flash parsers against a real full-flash backup of a RuView node.

Backups hold Wi-Fi passwords, so none ship with the repo: point EBENCH_BACKUP at one
(defaults to the oldest full backup eBench keeps). Run: uv run python tests/test_parse.py
"""

import os
import sys
from pathlib import Path

from ebench import parse

SAVES = Path.home() / "Library" / "Application Support" / "Lagreton eBench" / "saves"


def find_backup():
    path = os.environ.get("EBENCH_BACKUP") or next(iter(sorted(SAVES.glob("*/*_full.bin"), key=lambda p: p.name)), None)
    return Path(path) if path else None


def test_ruview_backup():
    path = find_backup()
    if not path:
        print("skipped: no backup (set EBENCH_BACKUP)")
        return
    img = path.read_bytes()
    read = lambda off, n: img[off:off + n]

    parts = parse.partition_table(read(0x8000, 0xC00))
    by = {p["label"]: p for p in parts}
    if "ota_1" not in by:
        print(f"skipped: {path.name} isn't a RuView node's backup (set EBENCH_BACKUP)")
        return
    assert (by["nvs"]["offset"], by["nvs"]["size"]) == (0x9000, 0x6000), by["nvs"]
    assert (by["ota_0"]["offset"], by["ota_1"]["offset"]) == (0x20000, 0x1F0000)
    assert by["otadata"]["subtype"] == "otadata" and by["ota_1"]["subtype"] == "ota_1"

    od = by["otadata"]
    boot = parse.boot_partition(parts, read(od["offset"], od["size"]))
    assert boot["label"] == "ota_0", boot

    app = parse.app_info(read(boot["offset"], 0x100))
    assert (app["project"], app["version"], app["idf"][:4]) == ("esp32-csi-node", "0.8.14", "v5.4"), app
    assert parse.app_info(read(by["ota_1"]["offset"], 0x100)) is None  # empty slot

    size = parse.image_size(read, boot["offset"])
    assert 900_000 < size < 960_000 and size % 16 == 0, size
    assert parse.image_size(read, 0x0) > 0  # bootloader

    settings, pages = parse.nvs(read(0x9000, 0x6000))
    values = {s["key"]: s["value"] for s in settings}
    assert pages >= 1
    assert values["node_id"] == 1 and values["target_port"] == 5005, "known RuView settings"
    assert values["target_ip"] == "192.168.1.4"
    assert any(s["type"] == "blob" for s in settings)  # Wi-Fi driver keeps blobs
    print(f"ok: {len(parts)} partitions, boots {boot['label']}, {app['project']} {app['version']}, "
          f"image {size} B, {len(settings)} settings in {pages} pages")


def test_show():
    assert parse.show(5) == "5"
    assert parse.show(b"hello\0\0") == "hello"
    assert parse.show(b"\x01\x02") == "01 02"
    assert parse.show(bytes(30)).endswith("(30 bytes)")


if __name__ == "__main__":
    os.chdir(Path(__file__).resolve().parent.parent)
    sys.path.insert(0, ".")
    test_show()
    test_ruview_backup()
