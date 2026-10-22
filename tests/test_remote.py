"""Check phone pairing and the phones' HTTPS listener end to end. Run: uv run python tests/test_remote.py"""

import base64
import hashlib
import http.client
import json
import ssl
import sys
import tempfile
import time
from pathlib import Path


def offer_of(code):
    raw = code.removeprefix("ebench://pair?d=")
    return json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))


def call(port, pin, method, path, token=None):
    """One request the way the phone makes it: no CA check, but the certificate must match the pin."""
    ctx = ssl.create_default_context()
    ctx.check_hostname, ctx.verify_mode = False, ssl.CERT_NONE
    conn = http.client.HTTPSConnection("127.0.0.1", port, context=ctx, timeout=5)
    conn.connect()
    assert hashlib.sha256(conn.sock.getpeercert(binary_form=True)).hexdigest() == pin, "pin doesn't match the served cert"
    conn.request(method, path, headers={"Authorization": f"Bearer {token}"} if token else {})
    status = conn.getresponse().status
    conn.close()
    return status


def test_pairing_and_listener():
    from ebench import app, board, remote
    with tempfile.TemporaryDirectory() as tmp:
        board.DATA = Path(tmp)
        remote.PORT = 0  # any free port
        remote.start(app.PhoneHandler)
        port = remote.server.server_address[1]
        offer = offer_of(remote.pair()["code"])
        token, pin = offer["token"], offer["pin"]

        assert remote.listing()["phones"] == [], "an unscanned code isn't a paired phone"
        assert call(port, pin, "GET", "/api/hello") == 401, "no token got in"
        assert call(port, pin, "GET", "/api/hello", "wrong") == 401
        assert call(port, pin, "GET", "/api/hello", token) == 200
        assert [p["name"] for p in remote.listing()["phones"]] == ["iPhone"], "first use didn't pair the phone"
        assert call(port, pin, "GET", "/api/state", token) == 200
        for mac_only in ("/api/lock/x", "/api/import/upload", "/api/phones/pair", "/api/reveal/x"):
            assert call(port, pin, "POST", mac_only, token) == 403, f"a phone reached {mac_only}"
        assert call(port, pin, "GET", "/index.html", token) == 403, "the phones' listener served UI files"

        # A second code replaces the first unscanned one, and runs out after PENDING seconds.
        stale = offer_of(remote.pair()["code"])["token"]
        fresh = offer_of(remote.pair()["code"])["token"]
        assert remote.check(stale) is None, "an older unscanned code still works"
        data = remote.phones()
        next(p for p in data.values() if not p.get("paired"))["expires"] = time.time() - 1
        board.write_json(remote.folder() / "phones.json", data)
        assert remote.check(fresh) is None, "an expired code still works"

        pid = remote.check(token)
        assert remote.remove(pid) and not remote.still_paired(pid)
        assert remote.check(token) is None, "a removed phone still gets in"
        assert remote.server is None, "the listener stayed open with no phones left"
        assert (remote.folder() / "key.pem").stat().st_mode & 0o777 == 0o600


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    test_pairing_and_listener()
    print("ok: pairing, pinned HTTPS, tokens, expiry, removal and Mac-only actions all hold")
