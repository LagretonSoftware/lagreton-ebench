"""Lock open, run on virtual S3 and C6 chips: no board needed. Run: uv run python tests/test_lock.py"""

import sys
from pathlib import Path

NOTE = lambda *a, **k: None


def blank(chip="esp32s3"):
    import espefuse
    return espefuse.SUPPORTED_CHIPS[chip].efuse_lib.EmulateEfuseController()


def blank_s3():
    return blank()


def test_lock_freezes_only_the_write_protect_bits():
    from ebench import lock
    for chip, fields in (("esp32s3", 30), ("esp32c6", 21)):
        sw, record = lock.lock_chip(blank(chip), chip, NOTE)
        assert all(s["frozen"] and s["safe"] for s in sw), chip
        assert (record["before"], record["after"]) == (0, 0x48014), f"{chip}: same bits as the XIAO's real lock"
        assert lock.MUST_FREEZE <= set(record["frozen"]) and len(record["frozen"]) == fields, chip


def test_lock_refuses_an_unsafe_or_locked_chip():
    import espefuse
    from ebench import lock
    chip = blank_s3()
    with espefuse.init_commands(esp=chip, do_not_confirm=True) as cmds:
        cmds.burn_efuse({"SECURE_BOOT_EN": 1})
    try:
        lock.lock_chip(chip, "esp32s3", NOTE)
        raise AssertionError("froze secure boot on")
    except ValueError as err:
        assert "safe position" in str(err)
    chip = blank_s3()
    lock.lock_chip(chip, "esp32s3", NOTE)
    try:
        lock.lock_chip(chip, "esp32s3", NOTE)
        raise AssertionError("locked twice")
    except ValueError as err:
        assert "already" in str(err)


def test_known_refuses_paths_and_strangers():
    from ebench import board
    for bad in ("../../etc", "aabbcc000001", "AA:BB:CC:00:00:01", "", None, "aa:bb:cc:dd:ee:ff/.."):
        assert board.known(bad) is None, bad
    assert board.known("00:00:00:00:00:01") is None, "no profile, not plugged in"


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    test_lock_freezes_only_the_write_protect_bits()
    test_lock_refuses_an_unsafe_or_locked_chip()
    test_known_refuses_paths_and_strangers()
    print("ok: lock on a virtual S3 and C6, refusals, MAC guard")
