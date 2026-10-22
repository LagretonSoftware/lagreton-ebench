"""Switch firmware: save the outgoing settings, scan, wipe settings areas, flash, put the incoming settings back, check."""

import re

from esptool.cmds import write_flash

from ebench import board, library, saves

# Flash encryption and secure boot are switched on by the bootloader on first boot, and an
# ESP-IDF bootloader built with either carries its messages. Normal bootloaders have none.
# (Apps can't be judged this way: every app links the encryption driver, used or not.)
LOCKOUT = re.compile(rb"(?i)flash[ _]?encrypt|secure[ _]?boot|crypt_cnt")


def scan(folder, plan):
    """Lockout markers in whatever lands below the partition table, i.e. the bootloader."""
    found = []
    for part in plan["parts"]:
        if part["address"] >= 0x8000:
            continue
        head = (folder / part["file"]).read_bytes()[:0x8000 - part["address"]]
        if m := LOCKOUT.search(head):
            found.append(f"{part['name']} mentions \"{m.group().decode(errors='replace')}\"")
    return found


def wipe_regions(b, plan):
    """Areas to erase before writing: both settings areas, and the incoming boot-slot data unless the plan brings its own."""
    regions = [r for r in (b.get("nvs"), plan.get("nvs")) if r]
    otadata = next((p for p in plan.get("table", []) if p["subtype"] == "otadata"), None)
    if otadata and not any(p["address"] <= otadata["offset"] < p["address"] + p["size"] for p in plan["parts"]):
        regions.append({"offset": otadata["offset"], "size": otadata["size"]})
    unique = {(r["offset"], r["size"]) for r in regions}
    return sorted(unique)


def settings_for(b, plan):
    """The newest settings save made by the incoming firmware that fits its settings area, or None."""
    project = (plan.get("app") or {}).get("project")
    nvs = plan.get("nvs")
    for s in board.listing(b["mac"]):
        fw = s.get("firmware") or {}
        if s["kind"] == "settings" and project and fw.get("project") == project and nvs == {"offset": s["offset"], "size": s["size"]}:
            return s
    return None


def summary(switches):
    return [(s["field"], s["on"], s["frozen"]) for s in switches]


def do_switch(port, b, report, target):
    folder, plan, name = library.resolve(target)
    outgoing = saves.firmware_of(b)
    before = summary(b["switches"])

    report(0, "Saving settings", "save", target=name, end=plan["end"])
    with saves.connect(port) as esp:
        saves.save_settings_with(esp, b, f"switched to {name}")

        report(0, f"Scanning {name}", "scan")
        if found := scan(folder, plan):
            esp.hard_reset()
            raise ValueError(f"Stopped before writing anything: {'; '.join(found)}. "
                             "This firmware may switch on encryption or secure boot.")

        report(0, f"Flashing {name}", "flash")
        for offset, size in wipe_regions(b, plan):
            esp.erase_region(offset, size)
        board.Quiet.local.report = lambda pct: report(pct, f"Flashing {name}", "flash")
        try:
            write_flash(esp, [(p["address"], (folder / p["file"]).read_bytes()) for p in plan["parts"]])
            back = settings_for(b, plan)
            if back:  # written separately: esptool refuses overlapping pieces in one call
                _, data = saves.load(b["mac"], back["id"])
                write_flash(esp, [(back["offset"], data)])
        finally:
            board.Quiet.local.report = None
        esp.hard_reset()

    report(100, "Checking switches", "check")
    mac, info = board.read_after_reset(port)
    entry = board.adopt(mac, info)
    with board.lock:
        if port in board.boards:
            board.boards[port] = {"port": board.short(port), **entry, "job": board.boards[port].get("job")}

    expected = (plan.get("app") or {}).get("project")
    running = info["running"]
    problems = []
    moved = summary(info["switches"]) != before
    board.record(mac, f"After switching to {name}: {'CHANGED, check them now' if moved else 'unchanged'}.")
    if moved:
        problems.append("the security switches changed")
        board.note(port, "Security switches changed during the switch: check Security now", "E")
    if expected and (not running or running["project"] != expected):
        problems.append(f"the board reports {running['project'] if running else 'no firmware'}, not {expected}")
    if problems:
        raise ValueError(f"{name} was written, but {' and '.join(problems)}.")
    kept = " Its last settings went back on." if back else " It starts fresh: no settings saved for it yet."
    left = f" {outgoing['project']} settings are saved for the switch back." if outgoing else ""
    return f"{name} is on the board.{left}{kept}"


def start(port_name, target):
    """Begin a switch. Returns None when started, or a sentence saying why not."""
    port = board.find(port_name)
    b = port and board.boards.get(port)
    if not b or b.get("status") != "ready":
        return "The board isn't ready."
    if not any(s["kind"] == "full" for s in board.listing(b["mac"])):
        return "Take a full backup of this board first (My boards › Saves), so there's always a way back."
    try:
        _, plan, name = library.resolve(target)
    except LookupError as err:
        return str(err)
    bad = [c["label"] for c in library.checks(plan, b) if not c["ok"] and not c.get("note")]
    if bad:
        return f"{name} doesn't fit this board: {', '.join(bad)}."
    if not saves.start(port_name, "switch", target, job=do_switch):
        return "The board is busy."
    return None
