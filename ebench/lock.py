"""Lock a board open: burn the write-protect eFuses of its four lockout switches, after a dry run on a virtual copy."""

import time

import espefuse

from ebench import board, saves

FIELDS = ["SPI_BOOT_CRYPT_CNT", "SECURE_BOOT_EN", "DIS_DOWNLOAD_MODE", "DIS_USB_SERIAL_JTAG"]
# Every field board.switches() reads must end up frozen, SECURE_VERSION included.
MUST_FREEZE = set(FIELDS) | {"SECURE_VERSION"}
# Chips whose bit groups were checked on a virtual chip: both burn WR_DIS 0x48014, which freezes
# 30 fields on the S3 and 21 on the C6, and nothing else changes (tests/test_lock.py).
CHIPS = {"ESP32-S3": "esp32s3", "ESP32-C6": "esp32c6"}


def fields(cmds):
    return {e.name: (e.get(), e.is_writeable()) for e in cmds.efuses}


def virtual_copy(esp, chip):
    """An emulated eFuse controller holding the same eFuse words as the chip esp talks to."""
    virt = espefuse.SUPPORTED_CHIPS[chip].efuse_lib.EmulateEfuseController()
    for name in virt.Blocks.BLOCKS:
        blk = virt.Blocks.get(name)
        for i in range(blk.len):
            addr = blk.rd_addr + 4 * i
            virt.update_reg(addr, 0xFFFFFFFF, esp.read_reg(addr))
    return virt


def simulate(esp, chip):
    """Burn the lock on a virtual copy of the chip. Returns the fields it froze; raises if it would do anything else."""
    virt = virtual_copy(esp, chip)
    with espefuse.init_commands(esp=esp) as real:
        live = fields(real)
    with espefuse.init_commands(esp=virt, do_not_confirm=True) as cmds:
        before = fields(cmds)
        if before != live:
            raise ValueError("The virtual copy doesn't match the chip, so nothing was burned.")
        cmds.write_protect_efuse(FIELDS)
    with espefuse.init_commands(esp=virt) as cmds:
        after = fields(cmds)
    changed = [n for n in before if n != "WR_DIS" and before[n][0] != after[n][0]]
    if changed:
        raise ValueError(f"On the virtual copy the lock also changed {', '.join(changed)}, so nothing was burned.")
    loose = [n for n in MUST_FREEZE if after[n][1]]
    if loose:
        raise ValueError(f"On the virtual copy {', '.join(loose)} stayed writable, so nothing was burned.")
    return [n for n in before if before[n][1] and not after[n][1]]


def lock_chip(esp, chip, report):
    """Simulate, burn, read back. Returns the switches as read back and a before/after record."""
    sw = board.switches(esp)
    if all(s["frozen"] for s in sw):
        raise ValueError("This board is already locked open.")
    if not all(s["safe"] for s in sw):
        raise ValueError("Not every switch is in its safe position, so locking now would freeze one the wrong way.")
    report(10, "Simulating on a virtual copy of this chip", "simulate")
    frozen = simulate(esp, chip)
    report(50, "Burning the write-protect fuses", "burn")
    with espefuse.init_commands(esp=esp, do_not_confirm=True) as cmds:
        wr_before = cmds.efuses["WR_DIS"].get()
        cmds.write_protect_efuse(FIELDS)  # checks each field reads back write-protected
    report(85, "Reading the switches back", "check")
    sw = board.switches(esp)
    with espefuse.init_commands(esp=esp) as cmds:
        wr_after = cmds.efuses["WR_DIS"].get()
    if not all(s["frozen"] and s["safe"] for s in sw):
        raise ValueError("The fuses were burned, but the read-back doesn't show all four frozen and safe. Check Security before flashing anything.")
    return sw, {"before": wr_before, "after": wr_after, "frozen": frozen, "when": time.strftime("%Y-%m-%dT%H:%M")}


def do_lock(port, b, report):
    with saves.connect(port) as esp:
        sw, record = lock_chip(esp, CHIPS[b["chip"]], report)
        esp.hard_reset()
    with board.lock:
        entry = board.boards.get(port)
        if entry:
            entry.update(switches=sw, lockedOpen=True)
    board.update_profile(b["mac"], lockedSince=time.strftime("%b %-d"), lock=record)
    board.record(b["mac"], f"Lock burned. Read back: all four frozen, {len(record['frozen'])} fields in all.")
    return "Locked open. The four switches are frozen for good."


def start(port_name):
    """Begin locking a board open. Returns None when started, or a sentence saying why not."""
    port = board.find(port_name)
    b = port and board.boards.get(port)
    if not b or b.get("status") != "ready":
        return "The board isn't ready."
    if b["chip"] not in CHIPS:
        return f"Lock open isn't available for the {b['chip']} yet."
    if b.get("lockedOpen"):
        return "This board is already locked open."
    if not saves.start(port_name, "lock", job=do_lock):
        return "The board is busy."
    return None
