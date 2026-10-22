"""Find ESP boards on USB, read what's on each one once, and remember it by MAC."""

import collections
import contextlib
import itertools
import json
import os
import re
import shutil
import struct
import threading
import time
from pathlib import Path

import espefuse
import serial
from esptool.cmds import detect_chip
from esptool.logger import TemplateLogger, log
from esptool.reset import HardReset
from serial.tools import list_ports

from ebench import parse


class Quiet(TemplateLogger):
    """esptool's logger, silenced, except that write progress goes to the job running on this thread."""

    local = threading.local()

    def progress_bar(self, cur_iter, total_iters, prefix="", suffix="", bar_length=30):
        report = getattr(self.local, "report", None)
        if report and total_iters:
            report(cur_iter * 100 // total_iters)

    def print(self, *args, **kwargs):
        pass

    note = warning = error = stage = set_verbosity = print


log.set_logger(Quiet())

DATA = Path.home() / "Library" / "Application Support" / "Lagreton eBench"
# Espressif's own USB, then the usual USB-serial bridge chips on dev boards.
USB_VIDS = {0x303A: "Serial/JTAG", 0x10C4: "CP210x bridge", 0x1A86: "CH34x bridge", 0x0403: "FTDI bridge"}
SYSTEM_NS = ("nvs.net80211", "phy")  # written by ESP-IDF itself, not the firmware

lock = threading.RLock()
boards = {}  # port -> {"status": "reading" | "ready" | "error", ...}


def store(name):
    """A private folder under Application Support: settings in here hold Wi-Fi passwords."""
    path = DATA / name
    path.mkdir(parents=True, exist_ok=True)
    for p in (DATA, path):
        os.chmod(p, 0o700)
    return path


MAC = re.compile(r"([0-9a-f]{2}:){5}[0-9a-f]{2}")


def write_json(path, data):
    """Write the whole file or nothing: the UI's stream reads these files several times a second."""
    tmp = path.with_name(f".{path.name}.{threading.get_ident()}")
    tmp.write_text(json.dumps(data, indent=1))
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def profile_path(mac):
    return store("boards") / f"{mac.replace(':', '')}.json"


def saved(mac):
    path = profile_path(mac)
    return json.loads(path.read_text()) if path.exists() else {}


def write_profile(mac, data):
    write_json(profile_path(mac), data)


def remember(mac, info):
    """Keep the last read plus anything the user set (name, model) for this board."""
    data = {**saved(mac), "last": info, "seen": time.strftime("%Y-%m-%dT%H:%M:%S")}
    write_profile(mac, data)
    return data


def known(mac):
    """mac if this Mac has a profile for it or it's plugged in, else None. Guards every path built from a MAC."""
    if not MAC.fullmatch(mac or ""):
        return None
    with lock:
        plugged = any(e.get("mac") == mac for e in boards.values())
    return mac if plugged or profile_path(mac).exists() else None


def update_profile(mac, **fields):
    """Write fields into a board's profile, and into its entry if it's plugged in."""
    with lock:
        data = {**saved(mac), **fields}
        write_profile(mac, data)
        for e in boards.values():
            if e.get("mac") == mac:
                e.update(fields, new=not data.get("name"))
    return data


def record(mac, what):
    """Add a line to the board's security history, newest first."""
    with lock:
        checks = [{"when": time.strftime("%Y-%m-%dT%H:%M"), "what": what}] + saved(mac).get("checks", [])
        update_profile(mac, checks=checks[:20])


def forget(mac):
    """Delete a board's profile and saves from this Mac. The board itself isn't touched."""
    with lock:
        mine = [e for e in boards.values() if e.get("mac") == mac]
        if any(e.get("job") for e in mine):
            return False
        shutil.rmtree(DATA / "saves" / mac.replace(":", ""), ignore_errors=True)
        profile_path(mac).unlink(missing_ok=True)
        for e in mine:
            for k in ("name", "model", "notes", "title", "checks", "lockedSince", "lock", "share"):
                e.pop(k, None)
            e.update(saves=[], new=True)
    return True


def save_folder(mac):
    return store(f"saves/{mac.replace(':', '')}")


def listing(mac):
    """This board's saves, newest first: metadata only, the .bin files stay on disk."""
    folder = DATA / "saves" / mac.replace(":", "")
    out = [{**json.loads(p.read_text()), "id": p.stem} for p in folder.glob("*.json")]
    return sorted(out, key=lambda s: s["created"], reverse=True)


def profiles():
    """Every named board this Mac knows, plugged in or not.

    ponytail: rereads every profile on each call (4x a second per window); cache it if boards pile up.
    """
    out = []
    for path in sorted((DATA / "boards").glob("*.json")):
        data = json.loads(path.read_text())
        last = data.get("last") or {}
        if not data.get("name") or not last.get("mac"):
            continue
        out.append({**{k: v for k, v in last.items() if k not in ("settings", "regions", "features")},
                    **{k: v for k, v in data.items() if k != "last"}, "saves": listing(last["mac"])})
    return out


def setting_text(s):
    v = s["value"]
    if isinstance(v, bytes) and s["key"].endswith(".ssid") and len(v) >= 4:
        n = struct.unpack_from("<I", v)[0]  # wifi_ssid_t: length, then up to 32 bytes
        v = v[4:4 + n] if n <= 32 else v
    return parse.show(v)


def switches(esp):
    """The four one-way eFuse switches that can lock a board, and whether each is frozen."""
    with espefuse.init_commands(esp=esp) as cmds:
        ef = cmds.efuses
        crypt = ef["SPI_BOOT_CRYPT_CNT"].get()
        usb_off = ef["DIS_DOWNLOAD_MODE"].get() or ef["DIS_USB_SERIAL_JTAG"].get()
        rows = [
            ("Encryption", bin(crypt).count("1") % 2 == 1, "SPI_BOOT_CRYPT_CNT"),
            ("Secure boot", ef["SECURE_BOOT_EN"].get(), "SECURE_BOOT_EN"),
            ("USB flashing", not usb_off, "DIS_DOWNLOAD_MODE"),
            ("Version lock", ef["SECURE_VERSION"].get() > 0, "SECURE_VERSION"),
        ]
        out = [{"label": f"{name} {'on' if on else 'off'}", "on": bool(on), "safe": on == (name == "USB flashing"),
                "frozen": not ef[field].is_writeable(), "field": field} for name, on, field in rows]
    return out


def settings_list(raw):
    found, pages = parse.nvs(raw)
    found.sort(key=lambda s: s["ns"] in SYSTEM_NS)  # firmware's own settings first
    return [{"ns": s["ns"], "key": s["key"], "type": s["type"], "value": setting_text(s)} for s in found], pages


def describe_flash(read):
    """Regions, running app, settings and settings area of a flash, through read(offset, length).

    Works the same on a live board (esp.read_flash) and on a backup file (a bytes slice).
    """
    parts = parse.partition_table(read(0x8000, 0xC00))
    od = next((p for p in parts if p["subtype"] == "otadata"), None)
    boot = parse.boot_partition(parts, read(od["offset"], od["size"]) if od else b"")
    regions = [{"name": "bootloader", "offset": 0, "size": 0x8000, "used": parse.image_size(read, 0)},
               {"name": "partition table", "offset": 0x8000, "size": 0x1000, "used": 32 * (len(parts) + 1) if parts else 0}]
    running, settings, nvs = None, [], None
    for p in parts:
        region = {"name": p["label"], "offset": p["offset"], "size": p["size"], "used": 0}
        if p["type"] == "app":
            app = parse.app_info(read(p["offset"], 0x100))
            region["app"] = app and app["project"]
            if app:
                region["used"] = parse.image_size(read, p["offset"])
            if p is boot:
                running = app and {**app, "slot": p["label"]}
        elif p["subtype"] == "nvs" and not nvs:
            nvs = {"offset": p["offset"], "size": p["size"]}
            settings, pages = settings_list(read(p["offset"], p["size"]))
            region["used"] = pages * parse.PAGE
        elif p["subtype"] == "otadata":
            region["used"] = p["size"] if parse.ota_sequence(read(p["offset"], p["size"])) else 0
        regions.append(region)
    return {"regions": regions, "running": running, "settings": settings, "nvs": nvs}


@contextlib.contextmanager
def connect_rom(port):
    """esptool's chip detection on a port we open ourselves: when detection fails, esptool leaves its
    own port open, and the board stays busy until eBench quits."""
    s = serial.serial_for_url(port, exclusive=True)
    try:
        yield detect_chip(s, connect_attempts=3)
    finally:
        s.close()


def read_board(port, vid):
    """Connect, read everything we show, then restart the board into its firmware (~2 s)."""
    with connect_rom(port) as rom:
        desc = rom.get_chip_description()  # "ESP32-S3 (QFN56) (revision v0.2)"
        features = rom.get_chip_features()
        mac = ":".join(f"{b:02x}" for b in rom.read_mac("BASE_MAC"))
        esp = rom.run_stub()
        flash = 2 ** ((esp.flash_id() >> 16) & 0xFF)
        layout = describe_flash(esp.read_flash)
        sw = switches(esp)
        esp.hard_reset()

    # chip is the family ("ESP32-C6"); desc names the exact variant ("ESP32-C6FH4 (QFN32) (revision v0.1)")
    psram = next((m.group(1) for f in features if (m := re.search(r"PSRAM (\d+MB)", f))), None)
    return mac, {
        "chip": rom.CHIP_NAME, "package": desc, "rev": (re.search(r"revision (v[\d.]+)", desc) or [None, "?"])[1],
        "features": features, "flash": flash, "psram": psram and psram.replace("MB", " MB"),
        "mac": mac, "usb": USB_VIDS.get(vid, "USB serial"), **layout, "switches": sw,
        "lockedOpen": all(s["frozen"] and s["safe"] for s in sw),
    }


def short(port):
    """"/dev/cu.usbmodem101" -> "usbmodem101", the name the UI shows and sends back."""
    return port.rsplit("/", 1)[-1].removeprefix("cu.")


def friendly(err):
    text = str(err)
    if isinstance(err, serial.SerialException) and ("busy" in text.lower() or "Errno 16" in text or "exclusively lock" in text):
        return "Another app is using this port. Close it, then try again."
    if "Failed to connect" in text or "No serial data" in text:
        return "The chip didn't answer. Hold BOOT while plugging it in, then try again."
    return text.splitlines()[0] if text else type(err).__name__


ANSI = re.compile(r"\x1b\[[0-9;]*m")
IDF_LINE = re.compile(r"^([EWIDV]) \((\d+)\) ([^:]+): (.*)$")  # "I (553) wifi: mode: sta"
logs = collections.defaultdict(lambda: collections.deque(maxlen=3000))  # short port -> lines
line_no = itertools.count(1)
held = set()        # ports esptool is using; the log reader lets go of them
restarts = set()    # ports whose reader should pulse reset
tailing = set()     # ports with a log reader running
gone = {}           # port -> (time, entry): boards on native USB vanish for a moment when they restart


def add(port, msg, lvl="", tag="", ms=None, src="board"):
    with lock:
        logs[short(port)].append({"n": next(line_no), "t": time.strftime("%H:%M:%S"), "ms": ms,
                                  "lvl": lvl, "tag": tag, "msg": msg, "src": src})


def note(port, msg, lvl="I"):
    """A line from eBench itself, mixed into the board's log."""
    add(port, msg, lvl, "ebench", src="lab")


def add_raw(port, raw):
    text = ANSI.sub("", raw.decode("utf-8", "replace")).rstrip("\r")
    if not text.strip():
        return
    m = IDF_LINE.match(text)
    if m:
        add(port, m[4], m[1], m[3], int(m[2]))
    else:
        add(port, text)


def sharing(port):
    """True while the board's port is left free for another app: the log reader keeps off it."""
    return boards.get(port, {}).get("share", False)


def tail(port):
    """Stream the board's serial output into its log until it's unplugged."""
    tailing.add(port)
    try:
        while port in boards or port in gone:
            if port in held or port not in boards or sharing(port):
                time.sleep(0.1)
                continue
            try:
                s = serial.Serial()
                s.port, s.baudrate, s.timeout = port, 115200, 0.2
                s.dtr = s.rts = False  # opening must neither reset the chip nor send it to the loader
                s.open()
                with s:
                    buf = b""
                    while port in boards and port not in held and not sharing(port):
                        if port in restarts:
                            restarts.discard(port)
                            note(port, "Restarted the board · boot output follows")
                            HardReset(s, uses_usb=boards[port].get("usb") == "Serial/JTAG")()
                        buf += s.read(s.in_waiting or 1)
                        *lines, buf = buf.split(b"\n")
                        for raw in lines:
                            add_raw(port, raw)
            except (serial.SerialException, OSError):
                time.sleep(0.1)  # unplugged, restarting, or briefly busy: try again soon
    finally:
        tailing.discard(port)


@contextlib.contextmanager
def hold(port):
    """Take the port away from the log reader while esptool uses it."""
    held.add(port)
    time.sleep(0.4)  # ponytail: the reader notices within one 0.2 s read timeout; an Event if that ever races
    try:
        yield
    finally:
        held.discard(port)


def adopt(mac, info):
    """A board entry from a fresh read, merged with what the user set for this board."""
    data = remember(mac, info)
    return {**info, **{k: v for k, v in data.items() if k not in ("last", "seen")},
            "saves": listing(mac), "status": "ready", "new": not data.get("name")}


def read_after_reset(port):
    """Read a board that was just reset. Boards on native USB drop off the bus for a moment, so retry."""
    vid = next((p.vid for p in list_ports.comports() if p.device == port), None)
    for attempt in range(6):
        try:
            return read_board(port, vid)
        except Exception:  # port not back yet, or the chip not answering yet
            if attempt == 5:
                raise
            time.sleep(1)


def read_into(port, vid):
    with lock:
        keep = {k: v for k, v in boards.get(port, {}).items() if k == "lastJob"}  # a restore's result outlives its re-read
        boards[port] = {"port": short(port), "status": "reading", **keep}
    note(port, "Reading the board · the log pauses for a moment")
    started = time.time()
    try:
        with hold(port):
            mac, info = read_board(port, vid)
        entry = adopt(mac, info)
        fw = info["running"]
        note(port, f"Read {entry.get('name') or info['chip']} in {time.time() - started:.1f} s · "
                   + (f"{fw['project']} {fw['version']} running" if fw else "no firmware found"))
    except Exception as err:  # any failure becomes a message on the board's card
        entry = {"status": "error", "error": friendly(err)}
        note(port, f"Couldn't read the board: {entry['error']}", "W")
    with lock:
        if port in boards:  # still plugged in
            boards[port] = {"port": short(port), **keep, **entry}
    if entry["status"] == "ready" and port not in tailing:
        threading.Thread(target=tail, args=(port,), daemon=True).start()


def watch(interval=0.5):
    """Poll USB: read each newly plugged-in board once, forget unplugged ones."""
    while True:
        found = {p.device: p.vid for p in list_ports.comports() if p.vid in USB_VIDS and "/cu." in p.device}
        now, new = time.time(), []
        with lock:
            for port in set(boards) - set(found) - held:
                gone[port] = (now, boards.pop(port))
            for port, (when, entry) in list(gone.items()):
                if port in found:
                    boards[port] = entry  # back within seconds: the same board restarting, not a new one
                    del gone[port]
                elif now - when > 5:
                    del gone[port]
                    note(port, "Board unplugged")
            for port in found:
                if port not in boards and port not in held:
                    boards[port] = {"port": short(port), "status": "reading"}
                    new.append(port)
        for port in new:
            note(port, f"Board plugged in on {short(port)}")
            threading.Thread(target=read_into, args=(port, found[port]), daemon=True).start()
        time.sleep(interval)


def find(port_name):
    return next((p for p in boards if short(p) == port_name), None)


def reread(port_name):
    """Read a board again (the UI's Try again button). Returns False if it isn't plugged in."""
    port = find(port_name)
    if not port or boards[port]["status"] == "reading":
        return bool(port)
    vid = next((p.vid for p in list_ports.comports() if p.device == port), None)
    threading.Thread(target=read_into, args=(port, vid), daemon=True).start()
    return True


def restart(port_name):
    """Pulse reset through the log reader, so the boot output lands in the log."""
    port = find(port_name)
    if port not in tailing or sharing(port):
        return False
    restarts.add(port)
    return True


def share(mac, on):
    """Free a board's port for other apps, or take it back for the live log. Remembered per board."""
    update_profile(mac, share=on)
    for port, e in list(boards.items()):
        if e.get("mac") == mac:
            note(port, "Port freed for other apps · the live log is off until you take it back" if on
                 else "Took the port back · the live log follows")


def save_log(port_name):
    """Write a board's log to ~/Downloads and return the path, or None for an unknown port."""
    with lock:
        if port_name not in logs:  # the name goes into a file path: only known ports
            return None
        lines = list(logs[port_name])
    path = Path.home() / "Downloads" / f"ebench-{port_name}-{time.strftime('%Y%m%d-%H%M%S')}.log"
    path.write_text("".join(
        f"{l['t']} {l['lvl'] or '-'} {'(' + str(l['ms']) + ') ' if l['ms'] is not None else ''}{l['tag'] + ': ' if l['tag'] else ''}{l['msg']}\n"
        for l in lines))
    return str(path)


def log_since(n):
    """Log lines numbered above n, grouped by port."""
    with lock:
        return {port: [l for l in lines if l["n"] > n] for port, lines in logs.items() if lines and lines[-1]["n"] > n}


def snapshot():
    with lock:
        return list(boards.values())
