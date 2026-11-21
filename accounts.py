"""
Light login: one admin account plus one account per player profile.

Passwords are stored as salted PBKDF2 hashes in data/auth.json, together with
the login sessions (random tokens the browser sends in the X-Session header).

The admin account is called "admin".  Its password comes from the
GENERACER_ADMIN_PASSWORD environment variable on the first start, or is
generated, printed and written to data/admin_password.txt.
"""

import hashlib
import hmac
import os
import secrets
import threading
import time

from garage import DATA_DIR, _load, _save

AUTH_FILE = os.path.join(DATA_DIR, "auth.json")
ADMIN_FILE = os.path.join(DATA_DIR, "admin_password.txt")
ADMIN_NAME = "admin"
SESSION_DAYS = 30        # normal logins
JOIN_HOURS = 12          # extra players who joined a hotseat race with their password


def _hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), 200_000)
    return {"salt": salt, "hash": digest.hex()}


def _matches(password, stored):
    if not stored:
        return False
    return hmac.compare_digest(_hash(password, stored["salt"])["hash"], stored["hash"])


def _require_password(password):
    if not isinstance(password, str) or password == "":
        raise ValueError("The password cannot be empty")
    return password


class Accounts:

    def __init__(self, garage):
        self.garage = garage
        self.lock = threading.Lock()
        self.data = _load(AUTH_FILE, {})
        self.data.setdefault("passwords", {})       # profile id -> hash
        self.data.setdefault("sessions", {})        # token -> {user, expires}
        self.data.setdefault("banned", {})          # profile id -> {name, reason, date}
        self.new_admin_password = None
        if "admin" not in self.data:
            password = os.environ.get("GENERACER_ADMIN_PASSWORD")
            if not password:
                password = secrets.token_urlsafe(9)
                self.new_admin_password = password
                os.makedirs(DATA_DIR, exist_ok=True)
                with open(ADMIN_FILE, "w", encoding="utf-8") as f:
                    f.write(f"Make No Mistakes! admin login\nusername: {ADMIN_NAME}\npassword: {password}\n"
                            "Change the password in the game, then delete this file.\n")
            self.data["admin"] = _hash(password)
        now = time.time()
        self.data["sessions"] = {t: s for t, s in self.data["sessions"].items() if s["expires"] > now}
        self._save()

    def _save(self):
        _save(AUTH_FILE, self.data)

    def _new_session(self, user, join=False):
        token = secrets.token_urlsafe(24)
        life = JOIN_HOURS * 3600 if join else SESSION_DAYS * 86400
        self.data["sessions"][token] = {"user": user, "expires": time.time() + life}
        self._save()
        return token

    # ---------------- sessions ----------------

    def session(self, token):
        """{"admin": bool, "profile_id": id or None} for a valid token, else None."""
        s = self.data["sessions"].get(token or "")
        if not s or s["expires"] < time.time():
            return None
        if s["user"] == ADMIN_NAME:
            return {"admin": True, "profile_id": None}
        if s["user"] in self.data["banned"]:
            return None
        try:
            self.garage._profile(s["user"])
        except KeyError:
            return None
        return {"admin": False, "profile_id": s["user"]}

    def login(self, name, password, join=False):
        """join=True: a short session for a player joining someone else's hotseat race."""
        if not isinstance(name, str) or not isinstance(password, str):
            raise ValueError("Wrong username or password")
        with self.lock:
            if name == ADMIN_NAME:
                if join or not _matches(password, self.data["admin"]):
                    raise ValueError("Wrong username or password")
                return {"token": self._new_session(ADMIN_NAME), "admin": True, "profile_id": None}
            profile = next((p for p in self.garage.profiles if p["name"] == name), None)
            if profile is None:
                raise ValueError("Wrong username or password")
            if profile["id"] in self.data["banned"]:
                raise ValueError("This account is banned for forged results. Elsa can unban it.")
            stored = self.data["passwords"].get(profile["id"])
            if stored is None:
                raise ValueError(f"{name} has no password yet. The admin can set one.")
            if not _matches(password, stored):
                raise ValueError("Wrong username or password")
            return {"token": self._new_session(profile["id"], join), "admin": False, "profile_id": profile["id"]}

    def logout(self, token):
        with self.lock:
            if self.data["sessions"].pop(token or "", None) is not None:
                self._save()

    # ---------------- accounts ----------------

    def register(self, name, password):
        """Creates a player page (profile with starter cars) and logs it in."""
        _require_password(password)
        profile = self.garage.create_profile(name)
        with self.lock:
            self.data["passwords"][profile["id"]] = _hash(password)
            token = self._new_session(profile["id"])
        return {"token": token, "admin": False, "profile_id": profile["id"]}

    def set_password(self, profile_id, password):
        _require_password(password)
        self.garage._profile(profile_id)
        with self.lock:
            self.data["passwords"][profile_id] = _hash(password)
            self._save()

    def set_admin_password(self, password):
        _require_password(password)
        with self.lock:
            self.data["admin"] = _hash(password)
            self._save()
        if os.path.exists(ADMIN_FILE):
            os.remove(ADMIN_FILE)

    def forget(self, profile_id):
        """After a profile is deleted: drop its password and log it out everywhere."""
        with self.lock:
            self.data["passwords"].pop(profile_id, None)
            self.data["banned"].pop(profile_id, None)
            self.data["sessions"] = {t: s for t, s in self.data["sessions"].items() if s["user"] != profile_id}
            self._save()

    def ban(self, profile_id, reason):
        """Logs the player out everywhere and refuses their logins until unban()."""
        with self.lock:
            if profile_id in self.data["banned"]:
                return
            try:
                name = self.garage._profile(profile_id)["name"]
            except KeyError:
                name = "?"
            self.data["banned"][profile_id] = {"name": name, "reason": str(reason)[:200], "date": time.time()}
            self.data["sessions"] = {t: s for t, s in self.data["sessions"].items() if s["user"] != profile_id}
            self._save()

    def unban(self, profile_id):
        with self.lock:
            if self.data["banned"].pop(profile_id, None) is None:
                raise KeyError("That player is not banned")
            self._save()

    def banned_list(self):
        """Newest ban first, with the player's current name when they still exist."""
        out = []
        for pid, b in self.data["banned"].items():
            try:
                name = self.garage._profile(pid)["name"]
            except KeyError:
                name = b["name"]
            out.append({"id": pid, "name": name, "reason": b["reason"], "date": b["date"]})
        return sorted(out, key=lambda b: -b["date"])

    def has_password(self, profile_id):
        return profile_id in self.data["passwords"]
