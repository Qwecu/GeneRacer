"""
Make No Mistakes! server.  Run:  py server.py   (then open http://localhost:2793)

Serves the static front end from ./static and a small JSON API backed by
garage.py.  Standard library only.

Every API call except login and registration needs a session token in the
X-Session header (see accounts.py).  Players may only change their own page;
the admin account may act as any player.
"""

import json
import os
import sys
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from accounts import ADMIN_FILE, ADMIN_NAME, Accounts
from garage import MAX_CARS, ForgeryError, Garage
from traits import trait_info_json

PORT = 2793
MAX_BODY = 1_000_000     # bytes; a ghost is about 200 kB
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
}

garage = Garage()
accounts = Accounts(garage)


class Forbidden(Exception):
    pass


class LoggedOut(Exception):
    pass


class Handler(BaseHTTPRequestHandler):

    # ---------------- auth helpers ----------------

    def _token(self):
        return self.headers.get("X-Session", "")

    def _who(self):
        who = accounts.session(self._token())
        if who is None:
            raise LoggedOut()
        return who

    @staticmethod
    def _may(who, profile_id):
        if not (who["admin"] or who["profile_id"] == profile_id):
            raise Forbidden("You can only change your own page")

    @staticmethod
    def _admin(who):
        if not who["admin"]:
            raise Forbidden("Only the admin can do that")

    # ---------------- GET ----------------

    def do_GET(self):
        path = self.path.split("?")[0]
        if not path.startswith("/api/"):
            return self._static(path)
        try:
            if path == "/api/me":
                who = accounts.session(self._token())
                return self._json(who and {**who, "name": ADMIN_NAME if who["admin"] else
                                           garage._profile(who["profile_id"])["name"]})
            who = self._who()
            if path == "/api/garage":
                return self._json({"cars": garage.list(), "trait_info": trait_info_json(), "max_cars": MAX_CARS})
            if path == "/api/profiles":
                return self._json([{**p, "has_password": accounts.has_password(p["id"])}
                                   for p in garage.list_profiles()])
            if path == "/api/banned":
                self._admin(who)
                return self._json(accounts.banned_list())
            if path == "/api/news":
                return self._json(garage.news_list())
            if path == "/api/taunts":
                # taunts other players sent the logged-in player (the admin gets none)
                return self._json([] if who["admin"] else garage.taunts_for(who["profile_id"]))
            if path == "/api/tracks":
                return self._json(garage.tracks)
            if path == "/api/records":
                # Every track's hall of fame, without ghosts (they are large).
                # /api/hall/<key> sends one track's list with its ghosts.
                summary = {k: [{kk: vv for kk, vv in e.items() if kk != "ghost"} for e in v]
                           for k, v in garage.records.items()}
                return self._json(summary)
            if path.startswith("/api/hall/"):
                return self._json(garage.hall(path[len("/api/hall/"):]))
            if path.startswith("/api/record/"):
                hall = garage.hall(path[len("/api/record/"):])
                return self._json(hall[0] if hall else None)
            self._respond(404, "text/plain", b"Not found")
        except LoggedOut:
            self._json({"error": "Please log in"}, code=401)
        except Forbidden as exc:
            self._json({"error": str(exc)}, code=403)

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
            if not 0 <= length <= MAX_BODY:
                return self._json({"error": "Request too large"}, code=413)
            body = json.loads(self.rfile.read(length) or b"{}")
            self._post(self.path, body)
        except LoggedOut:
            self._json({"error": "Please log in"}, code=401)
        except Forbidden as exc:
            self._json({"error": str(exc)}, code=403)
        except ForgeryError as exc:
            # reached only from player submissions: ban the sender (never the admin)
            who = accounts.session(self._token())
            if who and not who["admin"]:
                accounts.ban(who["profile_id"], str(exc))
                return self._json({"error": "Forged result detected. You are banned until Elsa unbans you.",
                                   "banned": True}, code=403)
            self._json({"error": str(exc)}, code=400)
        except (KeyError, ValueError, TypeError) as exc:
            self._json({"error": str(exc)}, code=400)

    def _post(self, path, body):
        ok = lambda: self._json({"ok": True})

        # ---- no login needed ----
        if path == "/api/login":
            return self._json(accounts.login(body["name"], body["password"], bool(body.get("join"))))
        if path == "/api/register":
            return self._json(accounts.register(body["name"], body["password"]))
        if path == "/api/logout":
            accounts.logout(self._token())
            for t in body.get("tokens", []):      # hotseat players who joined on this screen
                accounts.logout(t)
            return ok()

        who = self._who()

        # ---- player pages ----
        if path == "/api/random":
            self._may(who, body["owner"])
            return self._json(garage.random_car(body["owner"]))
        if path == "/api/breed":
            self._may(who, body["owner"])
            return self._json(garage.breed(body["a"], body["b"], body["owner"]))
        if path == "/api/delete":
            # one car {"id"} or several {"ids": [...]}
            ids = body["ids"] if "ids" in body else [body["id"]]
            for car_id in ids:
                self._may(who, garage.owner_of(car_id))
            garage.delete(ids)
            return ok()
        if path == "/api/rename":
            self._may(who, garage.owner_of(body["id"]))
            garage.rename(body["id"], body["name"])
            return ok()

        # ---- taunts ----
        if path == "/api/taunt":
            if who["admin"]:
                raise Forbidden("The admin has no races to boast about")
            n = garage.send_taunt(who["profile_id"], body["track"], body.get("track_name", ""), body["text"])
            return self._json({"ok": True, "sent": n})
        if path == "/api/taunts/read":
            if not who["admin"]:
                garage.mark_taunts_read(who["profile_id"])
            return ok()

        # ---- bans ----
        if path == "/api/unban":
            self._admin(who)
            accounts.unban(body["id"])
            return ok()

        # ---- accounts ----
        if path == "/api/profiles/create":
            self._admin(who)
            profile = garage.create_profile(body["name"])
            accounts.set_password(profile["id"], body["password"])
            return self._json(profile)
        if path == "/api/profiles/rename":
            self._may(who, body["id"])
            garage.rename_profile(body["id"], body["name"])
            return ok()
        if path == "/api/profiles/password":
            self._may(who, body["id"])
            accounts.set_password(body["id"], body["password"])
            return ok()
        if path == "/api/profiles/delete":
            self._may(who, body["id"])
            garage.delete_profile(body["id"])
            accounts.forget(body["id"])
            return ok()
        if path == "/api/admin/password":
            self._admin(who)
            accounts.set_admin_password(body["password"])
            return ok()

        # ---- races ----
        if path == "/api/drive":
            # Cars of the acting player, plus players who joined the hotseat
            # race with their own password (their tokens come along).
            allowed = {who["profile_id"]}
            for t in body.get("tokens", []):
                s = accounts.session(t)
                if s:
                    allowed.add(s["profile_id"])
            entries = body["entries"]
            if not who["admin"]:
                for e in entries:
                    try:
                        owner = garage.owner_of(e["id"])
                    except KeyError:
                        continue
                    if owner not in allowed:
                        raise Forbidden("A car in this race belongs to a player who has not joined")
            garage.add_distance(entries)
            return ok()
        if path == "/api/record":
            rec = body["record"]
            if not who["admin"] and (rec.get("profile_id") != who["profile_id"] or
                                     garage.owner_of(rec.get("car_id")) != rec.get("profile_id")):
                raise ForgeryError("A run was submitted for another player or car")
            self._may(who, rec.get("profile_id"))
            if garage.owner_of(rec.get("car_id")) != rec.get("profile_id"):
                raise Forbidden("That car belongs to another player")
            extra = {"status": body.get("status"), "track_name": body.get("track_name")}
            return self._json(garage.submit_record(body["track"], rec, extra))

        # ---- tracks (shared) ----
        if path == "/api/tracks/save":
            self._admin(who)
            garage.save_track(body["track"], ADMIN_NAME)
            return ok()
        if path == "/api/tracks/delete":
            self._admin(who)
            builtin = bool(body.get("builtin"))
            garage.delete_track(body["id"], builtin)
            return ok()
        if path == "/api/tracks/restore":
            self._admin(who)
            garage.restore_builtin_tracks()
            return ok()

        self._respond(404, "text/plain", b"Not found")

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


class Server(ThreadingHTTPServer):
    # On Windows, address reuse lets a second server bind the same port and
    # silently share requests with the first one.  Refuse instead.
    allow_reuse_address = sys.platform != "win32"


if __name__ == "__main__":
    try:
        server = Server(("localhost", PORT), Handler)
    except OSError:
        print(f"Port {PORT} is already in use: is Make No Mistakes! already running? "
              f"Open http://localhost:{PORT} or stop the other server first.")
        sys.exit(1)
    url = f"http://localhost:{PORT}"
    if accounts.new_admin_password:
        print(f"Created the admin account.  Username: {ADMIN_NAME}  Password: {accounts.new_admin_password}")
        print(f"(Also saved in {ADMIN_FILE}.  Change it in the game; the file is then deleted.)")
    print(f"Make No Mistakes! running at {url}  (Ctrl+C to stop)")
    if "--no-browser" not in sys.argv:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
