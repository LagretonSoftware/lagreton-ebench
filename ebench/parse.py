"""ESP-IDF flash structures from raw bytes, so a live board and a backup file read the same way."""

import struct
import zlib

APP_SUBTYPES = {0x00: "factory", 0x20: "test", **{0x10 + n: f"ota_{n}" for n in range(16)}}
DATA_SUBTYPES = {0x00: "otadata", 0x01: "phy", 0x02: "nvs", 0x03: "coredump", 0x04: "nvs_keys",
                 0x05: "efuse", 0x81: "fat", 0x82: "spiffs", 0x83: "littlefs"}


def cstr(raw):
    return raw.split(b"\0", 1)[0].decode("utf-8", "replace")


def partition_table(raw):
    """Entries of a partition table (read 0xC00 bytes at 0x8000)."""
    parts = []
    for i in range(0, len(raw) - 31, 32):
        e = raw[i:i + 32]
        if e[:2] != b"\xaa\x50":
            break  # 0xEBEB is the MD5 entry, 0xFFFF the end
        ptype, sub, offset, size = struct.unpack_from("<BBII", e, 2)
        parts.append({
            "label": cstr(e[12:28]), "type": "app" if ptype == 0 else "data" if ptype == 1 else hex(ptype),
            "subtype": (APP_SUBTYPES if ptype == 0 else DATA_SUBTYPES).get(sub, hex(sub)),
            "offset": offset, "size": size, "encrypted": bool(e[28] & 1),
        })
    return parts


def ota_sequence(raw):
    """Highest valid OTA sequence number in the otadata partition, or None (boots the first app)."""
    best = None
    for sector in (0, 0x1000):
        seq, state, crc = struct.unpack_from("<I20xII", raw, sector)
        invalid = state in (3, 4)  # ESP_OTA_IMG_INVALID, ESP_OTA_IMG_ABORTED
        if seq not in (0, 0xFFFFFFFF) and not invalid and crc == zlib.crc32(struct.pack("<I", seq), 0xFFFFFFFF):
            best = max(best or 0, seq)
    return best


def boot_partition(parts, otadata_raw):
    """The app partition the bootloader will start."""
    apps = [p for p in parts if p["type"] == "app"]
    otas = [p for p in apps if p["subtype"].startswith("ota_")]
    seq = ota_sequence(otadata_raw) if otadata_raw else None
    if seq and otas:
        return otas[(seq - 1) % len(otas)]
    return next((p for p in apps if p["subtype"] == "factory"), apps[0] if apps else None)


def app_info(head):
    """Firmware name and version from the first 0x100 bytes of an app image, or None."""
    if len(head) < 0xB0 + 32 or head[0] != 0xE9:
        return None
    d = head[32:]
    if struct.unpack_from("<I", d)[0] != 0xABCD5432:
        return None
    return {"version": cstr(d[16:48]), "project": cstr(d[48:80]), "time": cstr(d[80:96]),
            "date": cstr(d[96:112]), "idf": cstr(d[112:144])}


def image_size(read, offset):
    """Bytes used by the app or bootloader image at offset, or 0 if there is none."""
    head = read(offset, 24)
    if head[0] != 0xE9:
        return 0
    pos = offset + 24
    for _ in range(head[1]):
        pos += 8 + struct.unpack_from("<I", read(pos, 8), 4)[0]
    size = pos - offset + 1  # checksum byte
    size += -size % 16       # padded to 16
    return size + (32 if head[23] == 1 else 0)  # appended SHA-256


# NVS entry types
U8, I8, U16, I16, U32, I32, U64, I64, SZ, BLOB, BLOB_DATA, BLOB_IDX = (
    0x01, 0x11, 0x02, 0x12, 0x04, 0x14, 0x08, 0x18, 0x21, 0x41, 0x42, 0x48)
INTS = {U8: "<B", I8: "<b", U16: "<H", I16: "<h", U32: "<I", I32: "<i", U64: "<Q", I64: "<q"}
INTS_NAMES = {U8: "u8", I8: "i8", U16: "u16", I16: "i16", U32: "u32", I32: "i32", U64: "u64", I64: "i64"}
PAGE, ENTRY = 4096, 32
PAGE_IN_USE = (0xFFFFFFFE, 0xFFFFFFFC, 0xFFFFFFF8)  # active, full, freeing


def nvs(raw):
    """All settings in an NVS partition: [{"ns", "key", "type", "value"}], plus pages in use.

    Values are ints, strs or bytes. Later pages win when a key was rewritten.
    """
    pages = []
    for p in range(0, len(raw) - PAGE + 1, PAGE):
        state, seq = struct.unpack_from("<II", raw, p)
        if state in PAGE_IN_USE:
            pages.append((seq, p))
    pages.sort()

    names, items, chunks = {0: ""}, {}, {}
    for _, p in pages:
        bitmap = raw[p + 32:p + 64]
        i = 0
        while i < 126:
            if (bitmap[i // 4] >> (i % 4 * 2)) & 3 != 2:  # 2 = written
                i += 1
                continue
            e = raw[p + 64 + i * ENTRY:p + 64 + (i + 1) * ENTRY]
            ns, etype, span, chunk = e[0], e[1], max(e[2], 1), e[3]
            key, data = cstr(e[8:24]), e[24:32]
            if ns == 0 and etype == U8:
                names[data[0]] = key
            elif etype in INTS:
                items[(ns, key)] = (etype, struct.unpack_from(INTS[etype], data)[0])
            elif etype in (SZ, BLOB, BLOB_DATA):
                size = struct.unpack_from("<H", data)[0]
                payload = raw[p + 64 + (i + 1) * ENTRY:p + 64 + (i + span) * ENTRY][:size]
                if etype == BLOB_DATA:
                    chunks[(ns, key, chunk)] = payload
                else:
                    items[(ns, key)] = (etype, cstr(payload) if etype == SZ else payload)
            elif etype == BLOB_IDX:
                size, count, start = struct.unpack_from("<IBB", data)
                items[(ns, key)] = (BLOB_IDX, (size, count, start))
            i += span

    out = []
    for (ns, key), (etype, value) in items.items():
        if etype == BLOB_IDX:
            size, count, start = value
            value = b"".join(chunks.get((ns, key, start + n), b"") for n in range(count))[:size]
            etype = BLOB
        kind = "string" if etype == SZ else "blob" if etype == BLOB else INTS_NAMES[etype]
        out.append({"ns": names.get(ns, f"#{ns}"), "key": key, "type": kind, "value": value})
    return out, len(pages)


def show(value):
    """A setting value as text for the UI: printable blobs as text, others as hex."""
    if not isinstance(value, bytes):
        return str(value)
    text = value.rstrip(b"\0")
    if text and all(32 <= c < 127 for c in text):
        return text.decode()
    return value[:24].hex(" ") + (f" … ({len(value)} bytes)" if len(value) > 24 else "")
