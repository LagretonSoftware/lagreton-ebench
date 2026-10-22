"""Full backups (all of flash, checked by the board) and settings saves (the NVS partition), kept only on this Mac."""

import contextlib
import hashlib
import os
import subprocess
import threading
import time

from esptool.cmds import write_flash

from ebench import board


def write_save(mac, kind, data, meta):
    stamp = time.strftime("%Y-%m-%d_%H%M%S")
    stem = f"{stamp}_{kind}"
    folder = board.save_folder(mac)
    (folder / f"{stem}.bin").write_bytes(data)
    meta = {**meta, "kind": kind, "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    os.chmod(folder / f"{stem}.bin", 0o600)
    board.write_json(folder / f"{stem}.json", meta)  # last: the listing shows a save once its .bin is whole
    return stem


def load(mac, save_id):
    """A save's metadata and bytes. Only ids from this board's own listing are accepted."""
    meta = next((s for s in board.listing(mac) if s["id"] == save_id), None)
    if not meta:
        raise LookupError("That save doesn't belong to this board.")
    data = (board.save_folder(mac) / f"{save_id}.bin").read_bytes()
    if hashlib.sha256(data).hexdigest() != meta["sha256"]:
        raise ValueError("This save no longer matches its fingerprint, so it won't be written to the board.")
    return meta, data


def firmware_of(b):
    r = b.get("running")
    return {"project": r["project"], "version": r["version"]} if r else None


def save_settings_with(esp, b, why):
    """Copy the board's settings area into a settings save, over an open connection."""
    nvs = b.get("nvs")
    if not nvs:
        return None
    data = esp.read_flash(nvs["offset"], nvs["size"])
    return write_save(b["mac"], "settings", data, {"firmware": firmware_of(b), "why": why, **nvs})


@contextlib.contextmanager
def connect(port):
    """An esptool connection running the flasher stub; the port closes however it ends."""
    with board.connect_rom(port) as rom:
        yield rom.run_stub()


def do_backup(port, b, report):
    started = time.time()
    with connect(port) as esp:
        size = b["flash"]
        data = esp.read_flash(0, size, progress_fn=lambda done, total, _offset: report(done * 100 // total))
        report(100, "Checking the copy against the board")
        if esp.flash_md5sum(0, size) != hashlib.md5(data).hexdigest():
            raise ValueError("The copy doesn't match the board. Nothing was kept; try again.")
        esp.hard_reset()
    write_save(b["mac"], "full", data, {"firmware": firmware_of(b), "chip": b["chip"], "flash": size,
                                        "seconds": round(time.time() - started), "verified": True})
    return "Full backup taken and checked by the board"


def do_restore(port, b, report, save_id):
    meta, data = load(b["mac"], save_id)
    with connect(port) as esp:
        if meta["kind"] == "full":
            if meta["flash"] != b["flash"]:
                raise ValueError("That backup is for a different flash size.")
            address = 0
        else:
            if b.get("nvs") != {"offset": meta["offset"], "size": meta["size"]}:
                raise ValueError("This board keeps its settings somewhere else now, so they can't go back as they are.")
            address = meta["offset"]
        save_settings_with(esp, b, "before restore")
        board.Quiet.local.report = report
        try:
            write_flash(esp, [(address, data)])  # verifies the written data by itself
        finally:
            board.Quiet.local.report = None
        esp.hard_reset()
    return "Full backup restored" if meta["kind"] == "full" else "Settings restored"


def do_save_settings(port, b, report):
    with connect(port) as esp:
        stem = save_settings_with(esp, b, "saved by hand")
        esp.hard_reset()
    if not stem:
        raise ValueError("This board has no settings area to save.")
    return "Settings saved"


JOBS = {"backup": do_backup, "restore": do_restore, "save-settings": do_save_settings}
LABELS = {"backup": "Backing up", "restore": "Restoring", "save-settings": "Saving settings", "switch": "Switching",
          "lock": "Locking open"}


def start(port_name, kind, arg=None, job=None):
    """Run a job on a board in the background. False if the board is busy or missing.

    job(port, board_entry, report, *args) does the work; by default the one JOBS names for kind.
    """
    port = board.find(port_name)
    with board.lock:
        b = port and board.boards.get(port)
        if not b or b.get("status") != "ready" or b.get("job"):
            return False
        b["job"] = {"kind": kind, "label": LABELS[kind], "pct": 0}

    def report(pct, label=None, phase=None, **extra):
        with board.lock:
            current = board.boards.get(port, {}).get("job")
            if current:
                current.update(extra, pct=pct, label=label or LABELS[kind], phase=phase or current.get("phase"))

    def run():
        args = (arg,) if arg else ()
        rewrote = kind == "restore"
        board.note(port, f"{LABELS[kind]} · the log pauses until it's done")
        try:
            with board.hold(port):
                done = (job or JOBS[kind])(port, b, report, *args)
            result = {"kind": kind, "ok": True, "msg": done}
            board.note(port, done)
        except Exception as err:  # the message lands on the screen that started the job, and in the log
            result = {"kind": kind, "ok": False, "msg": board.friendly(err)}
            board.note(port, f"{LABELS[kind]} failed: {result['msg']}", "W")
            # a switch that failed after writing started leaves the board changed: show what's there now
            rewrote = kind == "switch" and (board.boards.get(port, {}).get("job") or {}).get("phase") in ("flash", "check")
        with board.lock:
            if port in board.boards:
                entry = board.boards[port]
                entry.pop("job", None)
                entry["lastJob"] = result
                entry["saves"] = board.listing(b["mac"])
        if rewrote:
            board.reread(port_name)

    threading.Thread(target=run, daemon=True).start()
    return True


def owned(mac, save_id):
    """True if save_id is one of this known board's saves. Every path below is built only after this."""
    return bool(board.known(mac)) and any(s["id"] == save_id for s in board.listing(mac))


def delete(mac, save_id):
    if not owned(mac, save_id):
        return False
    for ext in (".bin", ".json"):
        (board.save_folder(mac) / f"{save_id}{ext}").unlink(missing_ok=True)
    with board.lock:
        for e in board.boards.values():
            if e.get("mac") == mac:
                e["saves"] = board.listing(mac)
    return True


def reveal(mac, save_id):
    if not owned(mac, save_id):
        return False
    subprocess.run(["open", "-R", str(board.save_folder(mac) / f"{save_id}.bin")], check=False)
    return True


def details(mac, save_id):
    """What's inside a save, read from the file itself: flash map and settings. Works with the board unplugged."""
    if not owned(mac, save_id):
        raise LookupError("That save doesn't belong to this board.")
    meta, data = load(mac, save_id)
    if meta["kind"] == "full":
        return {**meta, **board.describe_flash(lambda off, n: data[off:off + n])}
    settings, _ = board.settings_list(data)
    return {**meta, "settings": settings}
