"""The firmware library: files you import, stored on this Mac, each with a plan of what goes where."""

import json
import re
import shutil
import struct
import tarfile
import time
import zipfile
from pathlib import Path

from ebench import board, parse

CHIP_IDS = {0: "ESP32", 2: "ESP32-S2", 5: "ESP32-C3", 9: "ESP32-S3", 12: "ESP32-C2",
            13: "ESP32-C6", 16: "ESP32-H2", 18: "ESP32-P4", 23: "ESP32-C5"}
MAX_UNPACKED = 64 << 20  # more than any ESP32's flash
MAX_ENTRIES = 1000
TOO_BIG = "The archive unpacks to more than 64 MB, more than any ESP32 holds, so it wasn't unpacked."
ID = re.compile(r"[A-Za-z0-9_-][A-Za-z0-9._-]*")


def root():
    path = board.store("library") / "imported"
    path.mkdir(exist_ok=True)
    return path


def extract(archive, out, name=None):
    """Unpack a .tar.gz or .zip into out, refusing entries that escape it or unpack past MAX_UNPACKED."""
    out.mkdir(parents=True, exist_ok=True)
    try:
        if (name or archive.name).endswith((".tar.gz", ".tgz")):
            with tarfile.open(archive) as tf:
                members = [m for m in tf.getmembers() if not m.name.endswith(".elf")]
                if len(members) > MAX_ENTRIES or sum(m.size for m in members if m.isfile()) > MAX_UNPACKED:
                    raise ValueError(TOO_BIG)
                tf.extractall(out, members=members, filter="data")
            return
        base, written = out.resolve(), 0
        with zipfile.ZipFile(archive) as zf:
            if len(zf.infolist()) > MAX_ENTRIES:
                raise ValueError(TOO_BIG)
            for m in zf.infolist():
                target = (out / m.filename).resolve()
                if not target.is_relative_to(base):
                    raise ValueError("The archive has files that would land outside its folder.")
                if m.is_dir() or m.filename.endswith(".elf"):
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(m) as src, open(target, "wb") as dst:
                    while chunk := src.read(1 << 16):  # count real bytes: a zip's size fields can lie
                        written += len(chunk)
                        if written > MAX_UNPACKED:
                            raise ValueError(TOO_BIG)
                        dst.write(chunk)
    except Exception:
        shutil.rmtree(out, ignore_errors=True)
        raise


def plan(folder):
    """Which file goes where, and what it is, for an unpacked firmware folder."""
    folder = folder.resolve()
    files = sorted(p for p in folder.rglob("*") if p.is_file() and not p.is_symlink() and p.name != "plan.json")
    heads = {p: p.read_bytes()[:0x8100] for p in files if p.suffix == ".bin"}
    args = next((p for p in files if p.name == "flasher_args.json"), None)
    table = next((parse.partition_table(h) for h in heads.values() if h[:2] == b"\xaa\x50"), [])
    if args:  # an ESP-IDF build folder says it outright, but only its own files at sane addresses count
        parts = []
        for off, rel in json.loads(args.read_text())["flash_files"].items():
            path, address = (args.parent / rel).resolve(), int(off, 16)
            if path not in files or not 0 <= address < MAX_UNPACKED:
                raise ValueError("flasher_args.json points outside the firmware folder or flash, so it wasn't used.")
            parts.append((address, path))
            heads.setdefault(path, path.read_bytes()[:0x8100])
    elif merged := next((p for p, h in heads.items() if h[:1] == b"\xe9" and h[0x8000:0x8002] == b"\xaa\x50"), None):
        parts = [(0, merged)]
        table = parse.partition_table(heads[merged][0x8000:0x8C00])
    else:  # loose pieces: place them by what they are and by the partition table
        boot = next((p for p, h in heads.items() if h[:1] == b"\xe9" and not parse.app_info(h[:0x100])), None)
        app = next((p for p, h in heads.items() if parse.app_info(h[:0x100])), None)
        otadata = next((p for p in heads if re.search(r"ota_data|boot_app0", p.name)), None)
        sub = {p["subtype"]: p["offset"] for p in table}
        app_at = sub.get("factory", sub.get("ota_0"))
        parts = [(0x1000 if boot and struct.unpack_from("<H", heads[boot], 12)[0] == 0 else 0, boot),
                 (0x8000, next((p for p, h in heads.items() if h[:2] == b"\xaa\x50"), None)),
                 (sub.get("otadata"), otadata), (app_at, app)]
        parts = [(off, p) for off, p in parts if p and off is not None]
    if not any(heads.get(p, b"")[:1] == b"\xe9" for _, p in parts):
        if any(h[:1] == b"\xe9" for h in heads.values()):
            raise ValueError("An app-only .bin can't be placed without its partition table: import the whole build folder or a merged image.")
        raise ValueError("That doesn't look like ESP32 firmware: no bootloader or app image inside.")

    images = [heads[p] for _, p in parts if heads.get(p, b"")[:1] == b"\xe9"]
    app = None
    for off, p in parts:
        data = p.read_bytes()
        app = app or parse.app_info(data[:0x100])
        for t in table:  # a merged image holds the app at its partition's offset
            if not app and t["type"] == "app" and off <= t["offset"] < off + len(data):
                app = parse.app_info(data[t["offset"] - off:t["offset"] - off + 0x100])
    labels = {t["offset"]: t["label"] for t in table}

    def part_name(off, p):
        if len(parts) == 1 and off == 0 and table:
            return "Everything (merged image)"
        if off == 0x8000:
            return "Partition table"
        if parse.app_info(heads.get(p, b"")[:0x100]):
            return f"App · {labels.get(off, hex(off))}"
        if heads.get(p, b"")[:1] == b"\xe9":
            return "Bootloader"
        return labels.get(off, p.name)

    return {
        "parts": [{"name": part_name(off, p), "address": off, "file": str(p.relative_to(folder)), "size": p.stat().st_size}
                  for off, p in parts],
        "chip": CHIP_IDS.get(struct.unpack_from("<H", images[0], 12)[0], "unknown"),
        "app": app, "end": max(off + p.stat().st_size for off, p in parts),
        "table_end": max((t["offset"] + t["size"] for t in table), default=0),
        "nvs": next(({"offset": t["offset"], "size": t["size"]} for t in table if t["subtype"] == "nvs"), None),
        "table": table,
    }


def import_path(src, name=None):
    """Import a .bin, archive or build folder into the library. Returns the plan or raises."""
    src = Path(src)
    name = name or src.name
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", name)[:60]
    out = root() / f"{time.strftime('%Y%m%d-%H%M%S')}_{safe}"
    try:
        if src.is_dir():
            out.mkdir(parents=True)
            for p in src.rglob("*"):  # only what flashing needs from a build folder
                if p.is_file() and (p.suffix == ".bin" or p.name in ("flasher_args.json", "flash_args")):
                    (out / p.relative_to(src)).parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(p, out / p.relative_to(src))
        elif name.endswith((".zip", ".tar.gz", ".tgz")):
            extract(src, out, name)
        elif name.endswith(".bin"):
            out.mkdir(parents=True)
            shutil.copy2(src, out / safe)
        else:
            raise ValueError("Import a .bin, a .zip or .tar.gz release, or an ESP-IDF build folder.")
        info = {**plan(out), "name": re.sub(r"\.(tar\.gz|tgz|zip|bin)$", "", Path(name).name), "imported": time.strftime("%Y-%m-%dT%H:%M:%S")}
        board.write_json(out / "plan.json", info)
        return info
    except Exception:
        shutil.rmtree(out, ignore_errors=True)
        raise


def checks(p, b):
    """What the Library shows before anything is written."""
    end = max(p["end"], p["table_end"])
    fits = end <= b["flash"]
    return [
        {"ok": p["chip"] == b["chip"], "label": f"Made for {p['chip']}",
         "detail": "Image header matches the chip" if p["chip"] == b["chip"] else f"This board is an {b['chip']}"},
        {"ok": fits, "label": f"Fits in {b['flash'] >> 20} MB",
         "detail": f"Uses up to 0x{end:X}" if fits else "Its layout is bigger than this board's flash"},
        {"ok": True, "label": "Lockout scan", "detail": "Runs again before every flash"},
    ]


def entries(b=None):
    """Every import, newest first. Given a ready board: whether each fits it and is the one running."""
    running = (b or {}).get("running") or {}
    out = []
    for path in sorted(root().glob("*/plan.json"), reverse=True):
        p = json.loads(path.read_text())
        app = p.get("app") or {}
        e = {"id": path.parent.name, "name": p.get("name", "Imported"), "mono": p.get("name", "IM")[:2].upper(),
             "ver": app.get("version", ""), "project": app.get("project"), "chip": p.get("chip"),
             "imported": p.get("imported", ""), "plan": p}
        if b:
            e["checks"] = checks(p, b)
            e["onBoard"] = (bool(app) and p.get("chip") == b["chip"]
                            and (app.get("project"), app.get("version")) == (running.get("project"), running.get("version")))
        out.append(e)
    if b:
        out.sort(key=lambda e: not all(c["ok"] for c in e["checks"]))  # what fits this board first
    return out


def folder(entry_id):
    """An import's folder, or None. The id comes from the UI, so only plain names pass."""
    path = root() / (entry_id or "")
    return path if ID.fullmatch(entry_id or "") and entry_id != ".." and path.is_dir() else None


def resolve(entry_id):
    """(folder, plan, name) of an import. Raises LookupError."""
    path = folder(entry_id)
    if not path or not (path / "plan.json").exists():
        raise LookupError("That firmware isn't in the library anymore.")
    p = json.loads((path / "plan.json").read_text())
    return path, p, p.get("name", "Imported firmware")


def delete(entry_id):
    path = folder(entry_id)
    if path:
        shutil.rmtree(path, ignore_errors=True)
    return bool(path)
