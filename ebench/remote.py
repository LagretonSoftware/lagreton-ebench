"""Phones: paired iPhones reach the same API over Wi-Fi or Tailscale, on an HTTPS listener of their own.

The listener stays closed until the first phone pairs. Each phone holds its own token, and pins this
Mac's self-signed certificate by the fingerprint in the pairing QR code, so nobody else on the network
can read or send its commands.
"""

import base64
import datetime
import hashlib
import ipaddress
import json
import re
import secrets
import socket
import socketserver
import ssl
import subprocess
import threading
import time
from http.server import ThreadingHTTPServer

from ebench import board

PORT = 47868  # fixed, so the addresses a phone saved still work after eBench restarts
PENDING = 600  # an unscanned pairing code works for 10 minutes
# A phone can do everything but these: lock open can't be undone, imports pick files on the Mac,
# reveal and save-log act on the Mac's own screen and disk, and a phone mustn't pair or remove phones.
MAC_ONLY = {"lock", "import", "reveal", "save-log", "phones"}

lock = threading.Lock()
seen = {}  # phone id -> time of its last request or stream tick, this run only
server = None
error = ""  # why the listener couldn't open, for the Phones popup


def folder():
    return board.store("phones")


def phones():
    path = folder() / "phones.json"
    return json.loads(path.read_text()) if path.exists() else {}


def digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


def run(*cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=3, check=False).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def hosts():
    """Where a phone can find this Mac: its .local name first (it survives a new Wi-Fi address), then every IPv4 address, Tailscale's 100.x too."""
    local = run("scutil", "--get", "LocalHostName")
    ips = [ip for ip in re.findall(r"inet (\d+\.\d+\.\d+\.\d+)", run("ifconfig"))
           if not (ipaddress.ip_address(ip).is_loopback or ipaddress.ip_address(ip).is_link_local)]
    return ([f"{local}.local"] if local else []) + ips


def hello():
    """What a phone refreshes on every connect: the Mac's name and current addresses."""
    return {"name": run("scutil", "--get", "ComputerName") or socket.gethostname(), "hosts": hosts(), "port": PORT}


def certificate():
    """This Mac's certificate and key, made once. Returns (cert path, key path)."""
    cert, key = folder() / "cert.pem", folder() / "key.pem"
    if not cert.exists() or not key.exists():
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.x509.oid import NameOID

        private = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Lagreton eBench")])
        now = datetime.datetime.now(datetime.UTC)
        made = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(private.public_key())
                .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(days=1))
                .not_valid_after(now + datetime.timedelta(days=3650)).sign(private, hashes.SHA256()))
        for path, data in ((key, private.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                                       serialization.NoEncryption())),
                           (cert, made.public_bytes(serialization.Encoding.PEM))):
            path.touch(mode=0o600)
            path.write_bytes(data)
    return cert, key


def pin():
    """The SHA-256 of the certificate: the phone accepts this Mac only if it matches."""
    return hashlib.sha256(ssl.PEM_cert_to_DER_cert(certificate()[0].read_text())).hexdigest()


def pair():
    """A fresh pairing code for one phone. Any older unscanned code stops working."""
    token = secrets.token_urlsafe(32)
    with lock:
        data = {pid: p for pid, p in phones().items() if p.get("paired")}
        data[secrets.token_hex(4)] = {"hash": digest(token), "expires": time.time() + PENDING}
        board.write_json(folder() / "phones.json", data)
    offer = {"v": 1, **hello(), "token": token, "pin": pin()}
    raw = base64.urlsafe_b64encode(json.dumps(offer, separators=(",", ":")).encode()).decode().rstrip("=")
    return {"code": f"ebench://pair?d={raw}", "expires": time.time() + PENDING}


def check(token, name=""):
    """The id of the phone this token belongs to, or None. An unscanned code becomes a paired phone on first use."""
    if not token:
        return None
    wanted = digest(token)
    with lock:
        data = phones()
        for pid, p in data.items():
            if not secrets.compare_digest(p["hash"], wanted):
                continue
            if not p.get("paired"):
                if p["expires"] < time.time():
                    return None
                del p["expires"]
                p.update(paired=datetime.datetime.now().isoformat(timespec="seconds"), name=name.strip()[:40] or "iPhone")
                board.write_json(folder() / "phones.json", data)
            seen[pid] = time.time()
            return pid
    return None


def still_paired(pid):
    """False once the phone is removed, which ends its live stream at the next tick."""
    if pid in phones():
        seen[pid] = time.time()
        return True
    return False


def remove(pid):
    with lock:
        data = phones()
        if data.pop(pid, None) is None:
            return False
        board.write_json(folder() / "phones.json", data)
    seen.pop(pid, None)
    if not any(p.get("paired") or p["expires"] > time.time() for p in data.values()):
        stop()  # nobody left who could connect
    return True


def listing():
    """The Phones popup: who's paired, when each was last heard from, and whether phones can connect."""
    now = time.time()
    paired = [{"id": pid, "name": p["name"], "paired": p["paired"], "ago": round(now - seen[pid]) if pid in seen else None}
              for pid, p in phones().items() if p.get("paired")]
    return {"phones": paired, "hosts": hosts(), "port": PORT, "open": server is not None, "error": error}


def qr(text):
    """The QR code for text as rows of "1"/"0" modules, drawn by macOS itself."""
    import AppKit
    import Quartz

    f = Quartz.CIFilter.filterWithName_("CIQRCodeGenerator")
    data = text.encode()
    f.setValue_forKey_(AppKit.NSData.dataWithBytes_length_(data, len(data)), "inputMessage")
    f.setValue_forKey_("M", "inputCorrectionLevel")
    rep = AppKit.NSBitmapImageRep.alloc().initWithCIImage_(f.outputImage())
    n = rep.pixelsWide()
    return ["".join("1" if rep.colorAtX_y_(x, y).brightnessComponent() < 0.5 else "0" for x in range(n)) for y in range(n)]


class Server(ThreadingHTTPServer):
    """IPv6 and IPv4 on one socket: a .local name often resolves to IPv6 first."""
    address_family = socket.AF_INET6

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        socketserver.TCPServer.server_bind(self)  # skip HTTPServer's reverse-DNS lookup of "::"
        self.server_name, self.server_port = "ebench", self.server_address[1]


def start(handler):
    """Open the phones' listener, if it isn't open. Called on pairing, and at launch when a phone is paired."""
    global server, error
    with lock:
        if server:
            return
        try:
            cert, key = certificate()
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.minimum_version = ssl.TLSVersion.TLSv1_2
            ctx.load_cert_chain(cert, key)
            s = Server(("::", PORT), handler)
            # The handshake runs in each request's own thread, so one stalled phone can't hold up the rest.
            s.socket = ctx.wrap_socket(s.socket, server_side=True, do_handshake_on_connect=False)
        except OSError as err:
            error = f"Phones can't connect: port {PORT} is taken ({err.strerror or err})."
            return
        server, error = s, ""
    threading.Thread(target=s.serve_forever, daemon=True).start()


def stop():
    global server
    with lock:
        s, server = server, None
    if s:
        threading.Thread(target=lambda: (s.shutdown(), s.server_close()), daemon=True).start()


def resume(handler):
    if any(p.get("paired") for p in phones().values()):
        start(handler)
