"""
GeneRacer server.  Run:  py server.py   (then open http://localhost:8766)

Serves the static front end from ./static and a small JSON API backed by
garage.py.  Standard library only.
"""

import json
import os
import sys
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from garage import Garage
from traits import trait_info_json

PORT = 8766
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
}

garage = Garage()


class Handler(BaseHTTPRequestHandler):

    # ---------------- GET ----------------

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/garage":
            return self._json({"cars": garage.list(), "trait_info": trait_info_json()})
        if path == "/api/profiles":
            return self._json(garage.list_profiles())
        if path == "/api/tracks":
            return self._json(garage.tracks)
        if path == "/api/records":
            # Every track's hall of fame, without ghosts (they are large).
            # /api/hall/<key> sends one track's list with all its ghosts.
            summary = {k: [{kk: vv for kk, vv in e.items() if kk != "ghost"} for e in v]
                       for k, v in garage.records.items()}
            return self._json(summary)
        if path.startswith("/api/hall/"):
            return self._json(garage.hall(path[len("/api/hall/"):]))
        if path.startswith("/api/record/"):
            hall = garage.hall(path[len("/api/record/"):])
            return self._json(hall[0] if hall else None)
        self._static(path)

    def _static(self, path):
        if path == "/":
            path = "/index.html"
        full = os.path.normpath(os.path.join(STATIC_DIR, path.lstrip("/")))
        if not full.startswith(STATIC_DIR) or not os.path.isfile(full):
            return self._respond(404, "text/plain", b"Not found")
        ctype = CONTENT_TYPES.get(os.path.splitext(full)[1], "application/octet-stream")
        with open(full, "rb") as f:
            self._respond(200, ctype, f.read())

    # ---------------- POST ----------------

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
            path = self.path
            if path == "/api/random":
                return self._json(garage.random_car(body["owner"]))
            if path == "/api/breed":
                return self._json(garage.breed(body["a"], body["b"], body["owner"]))
            if path == "/api/profiles/create":
                return self._json(garage.create_profile(body["name"]))
            if path == "/api/profiles/rename":
                garage.rename_profile(body["id"], body["name"])
                return self._json({"ok": True})
            if path == "/api/profiles/delete":
                garage.delete_profile(body["id"])
                return self._json({"ok": True})
            if path == "/api/delete":
                garage.delete(body["id"])
                return self._json({"ok": True})
            if path == "/api/rename":
                garage.rename(body["id"], body["name"])
                return self._json({"ok": True})
            if path == "/api/drive":
                garage.add_distance(body["entries"])
                return self._json({"ok": True})
            if path == "/api/tracks/save":
                garage.save_track(body["track"])
                return self._json({"ok": True})
            if path == "/api/tracks/delete":
                garage.delete_track(body["id"], bool(body.get("builtin")))
                return self._json({"ok": True})
            if path == "/api/tracks/restore":
                garage.restore_builtin_tracks()
                return self._json({"ok": True})
            if path == "/api/record":
                return self._json(garage.submit_record(body["track"], body["record"]))
            self._respond(404, "text/plain", b"Not found")
        except (KeyError, ValueError) as exc:
            self._json({"error": str(exc)}, code=400)

    # ---------------- helpers ----------------

    def _json(self, obj, code=200):
        self._respond(code, "application/json", json.dumps(obj).encode())

    def _respond(self, code, content_type, body):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(("localhost", PORT), Handler)
    url = f"http://localhost:{PORT}"
    print(f"GeneRacer running at {url}  (Ctrl+C to stop)")
    if "--no-browser" not in sys.argv:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
