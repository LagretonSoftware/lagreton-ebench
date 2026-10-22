"""Check the library's planner and unpacker on tiny fake firmware. Run: uv run python tests/test_library.py"""

import struct
import sys
import tempfile
import zipfile
from pathlib import Path


def entry(label, ptype, sub, offset, size):
    return b"\xaa\x50" + struct.pack("<BBII", ptype, sub, offset, size) + label.encode().ljust(16, b"\0") + bytes(4)


TABLE = entry("nvs", 1, 2, 0x9000, 0x6000) + entry("otadata", 1, 0, 0xF000, 0x2000) + entry("ota_0", 0, 0x10, 0x20000, 0x100000) + b"\xff" * 32


def image(chip=9, app=None):
    """An image header (magic, segment count 0, chip id at byte 12), plus an app descriptor if app."""
    head = bytearray(b"\xe9" + bytes(23))
    struct.pack_into("<H", head, 12, chip)
    if app:
        desc = bytearray(256)
        struct.pack_into("<I", desc, 0, 0xABCD5432)
        desc[16:16 + len(app[1])] = app[1].encode()
        desc[48:48 + len(app[0])] = app[0].encode()
        head += bytes(8) + desc
    return bytes(head)


def test_plans():
    from ebench import library
    with tempfile.TemporaryDirectory() as tmp:
        merged = Path(tmp, "merged")
        merged.mkdir()
        img = bytearray(b"\xff" * 0x20000)
        img[:24] = image()
        img[0x8000:0x8000 + len(TABLE)] = TABLE
        img += image(app=("demo_fw", "1.2.3"))
        (merged / "merged.bin").write_bytes(img)
        p = library.plan(merged)
        assert [(x["address"], x["name"]) for x in p["parts"]] == [(0, "Everything (merged image)")], p["parts"]
        assert p["chip"] == "ESP32-S3" and p["app"]["project"] == "demo_fw" and p["nvs"] == {"offset": 0x9000, "size": 0x6000}

        loose = Path(tmp, "loose")
        loose.mkdir()
        (loose / "bootloader.bin").write_bytes(image(chip=13))
        (loose / "partition-table.bin").write_bytes(TABLE)
        (loose / "ota_data_initial.bin").write_bytes(b"\xff" * 0x2000)
        (loose / "demo.bin").write_bytes(image(chip=13, app=("demo_fw", "2.0")))
        p = library.plan(loose)
        assert [x["address"] for x in p["parts"]] == [0, 0x8000, 0xF000, 0x20000], p["parts"]
        assert p["chip"] == "ESP32-C6" and p["app"]["version"] == "2.0"

        junk = Path(tmp, "junk")
        junk.mkdir()
        (junk / "notes.bin").write_bytes(b"hello")
        try:
            library.plan(junk)
            raise AssertionError("junk was accepted")
        except ValueError:
            pass


def test_zip_cannot_escape():
    from ebench import library
    with tempfile.TemporaryDirectory() as tmp:
        bad = Path(tmp, "bad.zip")
        with zipfile.ZipFile(bad, "w") as zf:
            zf.writestr("../escaped.bin", b"x")
        try:
            library.extract(bad, Path(tmp, "out"))
            raise AssertionError("zip slip was allowed")
        except ValueError:
            pass
        assert not Path(tmp, "escaped.bin").exists()


def test_archive_type_comes_from_its_real_name():
    """Downloads are unpacked from "<asset>.part": the asset's name, not the temp file's, picks tar or zip."""
    import io
    import tarfile
    from ebench import library
    with tempfile.TemporaryDirectory() as tmp:
        part = Path(tmp, "fw.tar.gz.part")
        with tarfile.open(part, "w:gz") as tf:
            info = tarfile.TarInfo("./app.bin")
            info.size = 3
            tf.addfile(info, io.BytesIO(b"abc"))
        library.extract(part, Path(tmp, "out"), "fw.tar.gz")
        assert Path(tmp, "out", "app.bin").read_bytes() == b"abc"


def test_flasher_args_cannot_point_outside():
    import json
    from ebench import library
    with tempfile.TemporaryDirectory() as tmp:
        Path(tmp, "secret.bin").write_bytes(image())
        fw = Path(tmp, "fw")
        fw.mkdir()
        (fw / "app.bin").write_bytes(image(app=("demo_fw", "1")))
        (fw / "flasher_args.json").write_text(json.dumps({"flash_files": {"0x0": "../secret.bin", "0x10000": "app.bin"}}))
        try:
            library.plan(fw)
            raise AssertionError("a file outside the folder was planned")
        except ValueError:
            pass


def test_import_ids_cannot_climb_out():
    from ebench import library
    for bad in ("..", ".", "../../boards", "a/../..", "", None, "/etc", "x/y"):
        assert library.folder(bad) is None, bad


def test_zip_bomb_is_refused():
    from ebench import library
    with tempfile.TemporaryDirectory() as tmp:
        bomb = Path(tmp, "bomb.zip")
        with zipfile.ZipFile(bomb, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("big.bin", bytes(library.MAX_UNPACKED + 1))  # ~64 MB of zeros, ~64 KB zipped
        try:
            library.extract(bomb, Path(tmp, "out"))
            raise AssertionError("the bomb was unpacked")
        except ValueError:
            pass
        assert not Path(tmp, "out").exists()  # partial output is cleaned up


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    test_plans()
    test_zip_cannot_escape()
    test_archive_type_comes_from_its_real_name()
    test_flasher_args_cannot_point_outside()
    test_zip_bomb_is_refused()
    test_import_ids_cannot_climb_out()
    print("ok: plans, junk, zip slip, temp-name tar, flasher_args escape and zip bomb all handled")
