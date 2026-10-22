"""Lagreton eBench: a local server does the board work, and a Mac window shows its UI."""

import argparse
import json
import secrets
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from ebench import board, library, lock, remote, saves, switch

UI =Path(__file__).parent / "ui"
HOSTS = {"127.0.0.1", "localhost", "ebench.localhost"}
# Every API call must carry this. Without it, any web page open in a browser
# could ask the app to flash a board.
KEY = secrets.token_urlsafe(24)

WINDOW = None  # the Mac window, for native file dialogs; None when serving a browser
MAX_IMPORT = 64 << 20


def state():
    """Everything the UI shows: each board with the library as that board sees it."""
    boards = [{**b, "library": library.entries(b)} if b.get("status") == "ready" else b for b in board.snapshot()]
    return {"boards": boards, "profiles": board.profiles(), "library": library.entries()}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(UI), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass

    def guard(self, api):
        """Refuse foreign Host headers (DNS rebinding) and API calls without the key."""
        if self.headers.get("Host", "").rsplit(":", 1)[0] not in HOSTS:
            self.send_error(403)
            return False
        # EventSource can't send headers, so the stream takes the key in its URL instead.
        key = self.headers.get("X-eBench-Key") or parse_qs(urlsplit(self.path).query).get("k", [""])[0]
        if api and not secrets.compare_digest(key, KEY):
            self.send_error(403)
            return False
        return True

    def live(self):
        return True

    def stream(self):
        """Server-sent events: the board list whenever it changes, and every new log line."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        sent_state, sent_line, sent_at = None, 0, time.time()
        try:
            while self.live():
                now = json.dumps(state())
                if now != sent_state:
                    self.wfile.write(f"event: state\ndata: {now}\n\n".encode())
                    sent_state, sent_at = now, time.time()
                lines = board.log_since(sent_line)
                if lines:
                    sent_line = max(group[-1]["n"] for group in lines.values())
                    self.wfile.write(f"event: log\ndata: {json.dumps(lines)}\n\n".encode())
                    sent_at = time.time()
                if time.time() - sent_at > 15:  # a comment line: keeps a quiet phone stream from timing out
                    self.wfile.write(b": ping\n\n")
                    sent_at = time.time()
                self.wfile.flush()
                time.sleep(0.25)
        except (BrokenPipeError, ConnectionResetError):
            pass  # window closed or reloaded

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        api = self.path.startswith("/api/")
        if not self.guard(api):
            return
        if not api:
            return super().do_GET()
        if self.path == "/api/state":
            return self.send_json(state())
        if self.path == "/api/hello":
            return self.send_json(remote.hello())
        if self.path == "/api/phones":
            return self.send_json(remote.listing())
        if self.path.startswith("/api/events?"):
            return self.stream()
        action, port, save_id = self.route()
        if action == "save":  # by MAC: a board's saves open with it unplugged
            try:
                return self.send_json(saves.details(port, save_id))
            except (LookupError, ValueError) as err:
                return self.send_json({"error": str(err)}, 404)
        self.send_error(404)

    def import_firmware(self, how):
        """/api/import/upload?name=<file> with the file as the body, or /api/import/<file|folder> for a native dialog."""
        try:
            if how == "upload":
                size = int(self.headers.get("Content-Length") or 0)
                if not 0 < size <= MAX_IMPORT:
                    raise ValueError("Imports can be up to 64 MB.")
                name = Path(parse_qs(urlsplit(self.path).query).get("name", ["firmware.bin"])[0]).name
                tmp = library.root() / f".upload-{secrets.token_hex(4)}"
                tmp.write_bytes(self.rfile.read(size))
                try:
                    info = library.import_path(tmp, name)
                finally:
                    tmp.unlink(missing_ok=True)
            elif how in ("file", "folder") and WINDOW:
                import webview
                kind = webview.FileDialog.FOLDER if how == "folder" else webview.FileDialog.OPEN
                picked = WINDOW.create_file_dialog(kind, file_types=() if how == "folder" else ("Firmware (*.bin;*.zip;*.tar.gz;*.tgz)",))
                if not picked:
                    return self.send_json({"cancelled": True})
                info = library.import_path(picked[0])
            elif how in ("file", "folder"):
                raise ValueError("The file picker works in the app window. In a browser, drop the file here instead.")
            else:
                return self.send_error(404)
            return self.send_json({"ok": True, "name": info.get("name")})
        except (ValueError, OSError) as err:
            return self.send_json({"error": str(err)}, 400)

    def save_profile(self, mac):
        """/api/profile/<mac> with {name, model, notes}: what the new-board popup and Edit details send."""
        size = int(self.headers.get("Content-Length") or 0)
        try:
            if not board.known(mac) or not 0 < size <= 4096:
                raise ValueError("Unknown board.")
            sent = json.loads(self.rfile.read(size))
            if not isinstance(sent, dict):
                raise ValueError("Send the details as an object.")
            fields = {k: str(sent.get(k) or "").strip()[:limit] for k, limit in (("name", 40), ("model", 60), ("notes", 200))}
        except ValueError as err:  # bad JSON lands here too
            return self.send_json({"error": str(err)}, 400)
        if not fields["name"] or not fields["model"]:
            return self.send_json({"error": "Give the board a name and pick its model."}, 400)
        first = not board.saved(mac).get("name")
        board.update_profile(mac, **fields)
        b = next((e for e in board.snapshot() if e.get("mac") == mac), None)
        if first and b and b.get("switches"):
            unsafe = [s["label"] for s in b["switches"] if not s["safe"]]
            board.record(mac, f"First read. {'Not safe: ' + ', '.join(unsafe) if unsafe else 'All four switches safe'}.")
        return self.send_json({"ok": True})

    def route(self):
        """/api/<action>/<port>?id=<save id>"""
        url = urlsplit(self.path)
        action, _, port = url.path.removeprefix("/api/").partition("/")
        return action, port, parse_qs(url.query).get("id", [None])[0]

    def do_POST(self):
        if not self.guard(True):
            return
        action, port, save_id = self.route()
        if action == "phones" and port == "pair":  # a new QR code; opens the phones' listener if it's closed
            remote.start(PhoneHandler)
            offer = remote.pair()
            return self.send_json({**offer, "qr": remote.qr(offer["code"]), "error": remote.error})
        if action == "phones" and port == "remove":
            ok = remote.remove(save_id)
            return self.send_json({"ok": ok}, 200 if ok else 404)
        if action == "delete-import":
            ok = library.delete(save_id)
            return self.send_json({"ok": ok}, 200 if ok else 404)
        if action == "import":
            return self.import_firmware(port)
        if action in ("backup", "save-settings") or (action == "restore" and save_id):
            ok = saves.start(port, action, save_id)
            return self.send_json({"ok": ok} if ok else {"error": "The board is busy or not ready."}, 200 if ok else 409)
        if action in ("delete-save", "reveal"):  # by MAC, like save
            ok = (saves.delete if action == "delete-save" else saves.reveal)(port, save_id)
            return self.send_json({"ok": ok}, 200 if ok else 404)
        if action == "profile":
            return self.save_profile(port)
        if action == "share":  # by MAC: /api/share/<mac>?on=1|0
            if not board.known(port):
                return self.send_json({"error": "Unknown board."}, 404)
            board.share(port, parse_qs(urlsplit(self.path).query).get("on", ["0"])[0] == "1")
            return self.send_json({"ok": True})
        if action == "forget":
            ok = bool(board.known(port)) and board.forget(port)
            return self.send_json({"ok": True} if ok else {"error": "The board is busy."}, 200 if ok else 409)
        if action == "lock":
            why_not = lock.start(port)
            return self.send_json({"error": why_not} if why_not else {"ok": True}, 409 if why_not else 200)
        if action == "read":
            ok = board.reread(port)
            return self.send_json({"ok": ok}, 200 if ok else 404)
        if action == "restart":
            ok = board.restart(port)
            return self.send_json({"ok": ok}, 200 if ok else 409)
        if action == "save-log":
            path = board.save_log(port)
            return self.send_json({"path": path}, 200 if path else 404)
        if action == "switch":
            why_not = switch.start(port, save_id or "")
            return self.send_json({"error": why_not} if why_not else {"ok": True}, 409 if why_not else 200)
        self.send_error(404)


class PhoneHandler(Handler):
    """The phones' listener: the same API, a paired phone's token instead of the window's key, and no UI files."""
    phone = None

    def guard(self, api):
        action = urlsplit(self.path).path.removeprefix("/api/").partition("/")[0]
        if not api or action in remote.MAC_ONLY:
            self.send_error(403)
            return False
        auth = self.headers.get("Authorization", "")
        self.phone = remote.check(auth.removeprefix("Bearer "), self.headers.get("X-eBench-Phone", ""))
        if not self.phone:
            self.send_error(401)  # the phone was removed, or its code expired: it has to pair again
            return False
        return True

    def live(self):
        return remote.still_paired(self.phone)


def blend_titlebar(window):
    """Drop the grey title bar: the page runs underneath and the traffic lights sit in its header."""
    import AppKit

    w = window.native
    w.setStyleMask_(w.styleMask() | AppKit.NSWindowStyleMaskFullSizeContentView)
    w.setTitlebarAppearsTransparent_(True)
    w.setTitleVisibility_(AppKit.NSWindowTitleHidden)
    w.setTitlebarSeparatorStyle_(AppKit.NSTitlebarSeparatorStyleNone)
    # pywebview paints the title bar view grey for normal windows; undo that.
    w.contentView().superview().subviews().lastObject().setBackgroundColor_(AppKit.NSColor.clearColor())
    # An empty unified toolbar makes the bar 52 pt tall, which centres the lights 26 pt down:
    # the middle of the UI's header pill (6 pt margin + 40 pt pill). Keep the two in step.
    w.setToolbar_(AppKit.NSToolbar.alloc().initWithIdentifier_("ebench"))
    w.setToolbarStyle_(AppKit.NSWindowToolbarStyleUnified)


def main():
    parser = argparse.ArgumentParser(prog="ebench")
    parser.add_argument("--dev", type=int, metavar="PORT", help="serve the UI for a browser on this port instead of opening a window")
    args = parser.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", args.dev or 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=board.watch, daemon=True).start()
    remote.resume(PhoneHandler)
    if args.dev:
        print(f"Lagreton eBench: http://ebench.localhost:{port}/#k={KEY}", flush=True)
        server.serve_forever()
        return

    import webview

    threading.Thread(target=server.serve_forever, daemon=True).start()
    webview.settings["DRAG_REGION_DIRECT_TARGET_ONLY"] = True  # drag the header, not its buttons
    global WINDOW
    window = WINDOW = webview.create_window("Lagreton eBench", f"http://127.0.0.1:{port}/#k={KEY}&window", width=1320, height=940,
                                   min_size=(1000, 720), background_color="#232327")
    window.events.before_show += lambda: blend_titlebar(window)
    webview.start()


if __name__ == "__main__":
    main()
