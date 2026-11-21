"""
Persistent player profiles, their cars, and track records, stored as JSON in ./data.
Every car has an `owner`: the id of the profile it belongs to.
"""

import json
import os
import random
import threading
import time
import uuid

from genome import CarGenome
from traits import express_car, genotype_table

# GENERACER_DATA lets you point the game at another save folder (handy for testing)
DATA_DIR = os.environ.get("GENERACER_DATA") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
CARS_FILE = os.path.join(DATA_DIR, "cars.json")
RECORDS_FILE = os.path.join(DATA_DIR, "records.json")
TRACKS_FILE = os.path.join(DATA_DIR, "tracks.json")
PROFILES_FILE = os.path.join(DATA_DIR, "profiles.json")
TAUNTS_FILE = os.path.join(DATA_DIR, "taunts.json")
NEWS_FILE = os.path.join(DATA_DIR, "news.json")

STARTER_CARS = 6
MAX_CARS = 20      # drivable cars one player may own; retired cars do not count
HALL_SIZE = 100    # places saved in each track's time-trial hall of fame
TAUNT_LENGTH = 140  # characters in one taunt
NEWS_KEPT = 100     # news posts saved
TAUNTS_KEPT = 50    # taunts kept per recipient; the oldest read ones go first
GHOST_PLACES = 10  # only the top places keep their ghost (they are large)
PROFILE_COLORS = ["#e74c3c", "#3498db", "#2ecc71", "#f1c40f", "#9b59b6", "#e67e22",
                  "#1abc9c", "#e84393", "#34495e", "#a0522d"]

_ADJ = [
    # the originals
    "Rusty", "Swift", "Lucky", "Grumpy", "Silver", "Midnight", "Thunder",
    "Little", "Mad", "Velvet", "Crimson", "Dusty", "Neon", "Iron", "Wild",
    "Sleepy", "Turbo", "Frosty", "Golden", "Wobbly", "Shadow", "Brave",
    # mood and character
    "Cheeky", "Jolly", "Sneaky", "Fearless", "Restless", "Cranky", "Gentle",
    "Proud", "Shy", "Bold", "Clumsy", "Daring", "Lazy", "Nervous", "Plucky",
    "Rowdy", "Sulky", "Wise", "Giddy", "Moody", "Noble", "Rebel", "Stubborn",
    "Humble", "Feisty", "Dreamy", "Hasty", "Patient",
    # speed and sound
    "Rapid", "Blazing", "Roaring", "Howling", "Screaming", "Whispering",
    "Rumbling", "Zippy", "Snappy", "Dashing", "Drifting", "Flying", "Hurtling",
    "Buzzing", "Purring", "Rattling", "Sputtering", "Grinding",
    # colour and look
    "Scarlet", "Cobalt", "Emerald", "Amber", "Ivory", "Obsidian", "Copper",
    "Bronze", "Chrome", "Pastel", "Ruby", "Jade", "Indigo", "Saffron",
    "Teal", "Violet", "Smoky", "Glossy", "Speckled", "Striped", "Polished",
    "Dented", "Patched", "Shiny",
    # weather and nature
    "Stormy", "Misty", "Sunny", "Windy", "Icy", "Molten", "Arctic", "Desert",
    "Tropical", "Autumn", "Winter", "Lunar", "Solar", "Cosmic", "Northern",
    "Wandering", "Feral", "Ancient", "Electric", "Atomic", "Mystic",
    # size and age
    "Tiny", "Mighty", "Chunky", "Lanky", "Pocket", "Grand", "Old", "Young",
    "Vintage", "Retro", "Elder", "Baby",
]
_NOUN = [
    # the originals
    "Comet", "Beetle", "Hornet", "Badger", "Rocket", "Pike", "Otter",
    "Falcon", "Lynx", "Moose", "Bolt", "Viper", "Kettle", "Biscuit",
    "Gremlin", "Puffin", "Mantis", "Raven", "Ferret", "Wombat", "Squall",
    # animals
    "Hedgehog", "Weasel", "Marten", "Stoat", "Reindeer", "Elk", "Hare",
    "Squirrel", "Beaver", "Walrus", "Seal", "Orca", "Narwhal", "Shark",
    "Barracuda", "Salmon", "Perch", "Eel", "Gecko", "Iguana", "Cobra",
    "Python", "Tortoise", "Toad", "Newt", "Heron", "Stork", "Crane", "Owl",
    "Hawk", "Kestrel", "Swallow", "Magpie", "Jackdaw", "Pelican", "Penguin",
    "Albatross", "Gull", "Wolf", "Fox", "Bear", "Panther", "Jaguar", "Cheetah",
    "Lion", "Tiger", "Llama", "Yak", "Bison", "Rhino", "Hippo", "Gazelle",
    "Kangaroo", "Koala", "Lemur", "Sloth", "Armadillo", "Raccoon", "Mole",
    "Bumblebee", "Dragonfly", "Firefly", "Ladybird", "Cricket", "Wasp",
    # weather and sky
    "Storm", "Tornado", "Cyclone", "Blizzard", "Avalanche", "Thunderbolt",
    "Meteor", "Nova", "Quasar", "Nebula", "Eclipse", "Aurora", "Mirage",
    "Tempest", "Gale", "Breeze", "Hailstone", "Sunbeam", "Moonbeam",
    # things
    "Teapot", "Toaster", "Spanner", "Hammer", "Anvil", "Lantern", "Compass",
    "Pretzel", "Dumpling", "Muffin", "Pancake", "Waffle", "Meatball",
    "Pickle", "Turnip", "Radish", "Pepper", "Noodle", "Crumpet", "Bagel",
    "Sprocket", "Piston", "Gizmo", "Widget", "Trumpet", "Banjo", "Kazoo",
    "Boomerang", "Yo-yo", "Pinball", "Marble", "Arrow", "Javelin", "Cannonball",
    # characters
    "Bandit", "Pirate", "Rascal", "Outlaw", "Ranger", "Nomad", "Wizard",
    "Goblin", "Troll", "Pixie", "Sprite", "Phantom", "Knight", "Baron",
    "Duchess", "Captain", "Maverick", "Drifter", "Jester", "Scout",
]

_lock = threading.Lock()


def _random_name(existing):
    for _ in range(50):
        name = f"{random.choice(_ADJ)} {random.choice(_NOUN)}"
        if name not in existing:
            return name
    return f"{random.choice(_ADJ)} {random.choice(_NOUN)} {random.randint(2, 99)}"


def _load(path, default):
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _save(path, data):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)


class Garage:

    def __init__(self):
        self.cars = _load(CARS_FILE, [])
        # records: {track key: [hall of fame entries, best first]}.  Saves from
        # before the hall of fame held a single record per track.
        self.records = {k: (v if isinstance(v, list) else [v])
                        for k, v in _load(RECORDS_FILE, {}).items()}
        # custom: saved seed-generated track definitions; hidden: ids of built-in tracks the admin removed
        self.tracks = _load(TRACKS_FILE, {"custom": [], "hidden": []})
        self.profiles = _load(PROFILES_FILE, [])
        self._pending = {}     # (profile id, track key) -> {"to": profile ids below the car, "news": post id}
        self.news = _load(NEWS_FILE, [])         # oldest first, last NEWS_KEPT kept
        self.taunts = _load(TAUNTS_FILE, [])     # [{id, from, to, track, track_name, text, date, read}]
        if not self.profiles and self.cars:
            # Data from before profiles existed: everything already in the
            # garage belongs to the first player.
            first = self._new_profile("Player 1", starters=False)
            for c in self.cars:
                c.setdefault("owner", first["id"])
            self._persist()
            _save(PROFILES_FILE, self.profiles)

    # ---------------- helpers ----------------

    def _persist(self):
        _save(CARS_FILE, self.cars)

    def _find(self, car_id):
        for c in self.cars:
            if c["id"] == car_id:
                return c
        raise KeyError(f"No car {car_id}")

    def _new_profile(self, name, starters=True):
        used = {p["color"] for p in self.profiles}
        color = next((c for c in PROFILE_COLORS if c not in used), random.choice(PROFILE_COLORS))
        profile = {"id": uuid.uuid4().hex[:8], "name": name, "color": color, "created": time.time()}
        self.profiles.append(profile)
        if starters:
            for _ in range(STARTER_CARS):
                self._add(CarGenome(), generation=0, parents=[], owner=profile["id"])
        return profile

    def _profile(self, profile_id):
        for p in self.profiles:
            if p["id"] == profile_id:
                return p
        raise KeyError(f"No player {profile_id}")

    def _check_username(self, name, profile_id=None):
        """A player name is also the login name: anything but empty, taken or "admin"."""
        if not isinstance(name, str) or name == "":
            raise ValueError("The username cannot be empty")
        if len(name) > 200:
            raise ValueError("The username is too long")
        if name == "admin":
            raise ValueError("The name admin is reserved")
        if any(p["name"] == name and p["id"] != profile_id for p in self.profiles):
            raise ValueError(f"The name {name} is already taken")
        return name

    def owner_of(self, car_id):
        return self._find(car_id).get("owner")

    def _add(self, genome, generation, parents, owner):
        car = {
            "id": uuid.uuid4().hex[:10],
            "owner": owner,
            "name": _random_name({c["name"] for c in self.cars}),
            "generation": generation,
            "parents": parents,
            "born": time.time(),
            "odometer_km": 0.0,
            "races": 0,
            "genome": genome.to_dict(),
        }
        self.cars.append(car)
        return car

    @staticmethod
    def public(car):
        genome = CarGenome.from_dict(car["genome"])
        looks, stats, sound = express_car(genome)
        return {
            "id": car["id"],
            "name": car["name"],
            "owner": car.get("owner"),
            "generation": car["generation"],
            "parents": car["parents"],
            "odometer_km": round(car["odometer_km"], 2),
            "races": car.get("races", 0),
            "retired": car["odometer_km"] >= stats["lifespan_km"],
            "looks": looks,
            "stats": stats,
            "sound": sound,
            "genotype": genotype_table(genome),
        }

    # ---------------- API ----------------

    def list(self):
        return [self.public(c) for c in self.cars]

    # ---------------- profiles ----------------

    def list_profiles(self):
        counts = {}
        for c in self.cars:
            counts[c.get("owner")] = counts.get(c.get("owner"), 0) + 1
        return [{**p, "cars": counts.get(p["id"], 0)} for p in self.profiles]

    def create_profile(self, name):
        with _lock:
            self._check_username(name)
            profile = self._new_profile(name, starters=True)
            self._persist()
            _save(PROFILES_FILE, self.profiles)
            return profile

    def rename_profile(self, profile_id, name):
        with _lock:
            self._profile(profile_id)
            self._check_username(name, profile_id)
            self._profile(profile_id)["name"] = name
            _save(PROFILES_FILE, self.profiles)

    def delete_profile(self, profile_id):
        """Removes the player and all their cars.  Records they set stay."""
        with _lock:
            self._profile(profile_id)
            self.profiles = [p for p in self.profiles if p["id"] != profile_id]
            self.cars = [c for c in self.cars if c.get("owner") != profile_id]
            self.taunts = [t for t in self.taunts if profile_id not in (t["from"], t["to"])]
            self._persist()
            _save(PROFILES_FILE, self.profiles)
            _save(TAUNTS_FILE, self.taunts)

    # ---------------- cars ----------------

    @staticmethod
    def _retired(car):
        _, stats, _ = express_car(CarGenome.from_dict(car["genome"]))
        return car["odometer_km"] >= stats["lifespan_km"]

    def _check_room(self, owner):
        drivable = sum(1 for c in self.cars if c.get("owner") == owner and not self._retired(c))
        if drivable >= MAX_CARS:
            raise ValueError(f"The garage is full ({MAX_CARS} drivable cars). Delete a car first.")

    def random_car(self, owner):
        with _lock:
            self._profile(owner)
            self._check_room(owner)
            car = self._add(CarGenome(), generation=0, parents=[], owner=owner)
            self._persist()
            return self.public(car)

    def breed(self, id_a, id_b, owner):
        if id_a == id_b:
            raise ValueError("A car cannot breed with itself")
        with _lock:
            self._profile(owner)
            self._check_room(owner)
            a = self._find(id_a)
            b = self._find(id_b)
            if a.get("owner") != owner or b.get("owner") != owner:
                raise ValueError("You can only breed your own cars")
            child_genome = CarGenome.make_child(
                CarGenome.from_dict(a["genome"]), CarGenome.from_dict(b["genome"]))
            child = self._add(
                child_genome,
                generation=max(a["generation"], b["generation"]) + 1,
                parents=[a["name"], b["name"]],
                owner=owner,
            )
            self._persist()
            return self.public(child)

    def delete(self, car_ids):
        with _lock:
            gone = set(car_ids)
            self.cars = [c for c in self.cars if c["id"] not in gone]
            self._persist()

    def rename(self, car_id, name):
        name = str(name).strip()[:40]
        if not name:
            raise ValueError("Empty name")
        with _lock:
            self._find(car_id)["name"] = name
            self._persist()

    def add_distance(self, entries):
        """entries: [{id, km}] driven in a finished race run."""
        with _lock:
            for e in entries:
                try:
                    car = self._find(e["id"])
                except KeyError:
                    continue
                car["odometer_km"] += max(0.0, float(e["km"]))
                car["races"] = car.get("races", 0) + 1
            self._persist()

    # ---------------- records ----------------

    @staticmethod
    def _better(new, old):
        """Finished beats unfinished; then faster time; else further distance."""
        if old is None:
            return True
        if new["finished"] != old["finished"]:
            return new["finished"]
        if new["finished"]:
            return new["time"] < old["time"]
        return new["distance"] > old["distance"]

    @staticmethod
    def _rank_key(entry):
        """Sort key: finishers by time, then everyone else by distance."""
        return (0, entry["time"]) if entry["finished"] else (1, -entry["distance"])

    def hall(self, track_id):
        return self.records.get(track_id, [])

    def submit_record(self, track_id, rec, extra=None):
        """
        Offer a time-trial run to the track's shared hall of fame (top
        HALL_SIZE).  Each player+car pair holds at most one place, replaced
        only when beaten.  The top GHOST_PLACES entries keep their ghost;
        an entry that drops below them loses it.

        Returns {"rank": n or None, "best_rank": rank of this player+car's
        entry after the update, or None, "surpassed": [{"id", "name"}]}.
        "surpassed" lists the other players with a place below this car's new
        place anywhere in the hall of fame (they can be taunted).
        """
        rec = {
            "finished": bool(rec["finished"]),
            "time": float(rec["time"]),
            "distance": float(rec["distance"]),
            "car_name": str(rec.get("car_name", "?"))[:40],
            "car_id": str(rec.get("car_id", ""))[:20],
            "driver": str(rec.get("driver", "?"))[:40],
            "profile_id": str(rec.get("profile_id", ""))[:20],
            "ghost": rec.get("ghost", [])[:6000],
            "looks": rec.get("looks", {}),
            "date": time.time(),
        }
        if not rec["finished"] and rec["distance"] <= 0:
            return {"rank": None, "best_rank": None, "surpassed": []}
        mine = lambda e: rec["profile_id"] and e.get("profile_id") == rec["profile_id"] and e.get("car_id") == rec["car_id"]
        with _lock:
            hall = list(self.hall(track_id))
            previous = next((e for e in hall if mine(e)), None)
            old = list(hall)
            self._pending.pop((rec["profile_id"], track_id), None)
            if previous is not None and not self._better(rec, previous):
                return {"rank": None, "best_rank": hall.index(previous) + 1, "surpassed": []}
            hall = [e for e in hall if e is not previous] + [rec]
            hall.sort(key=self._rank_key)       # stable: on a tie the older run stays ahead
            hall = hall[:HALL_SIZE]
            if not any(e is rec for e in hall):
                return {"rank": None, "best_rank": None, "surpassed": []}
            for e in hall[GHOST_PLACES:]:
                e.pop("ghost", None)
            self.records[track_id] = hall
            _save(RECORDS_FILE, self.records)
            rank = next(i for i, e in enumerate(hall) if e is rec) + 1
            surpassed = self._below(hall, rec)
            old_rank = old.index(previous) + 1 if previous is not None else None
            # every accepted run changes the hall of fame (a new place or a better run)
            news_id = self._post_news(old, hall, rec, previous, rank, old_rank, track_id, extra)
            if surpassed:
                self._pending[(rec["profile_id"], track_id)] = {"to": [p["id"] for p in surpassed], "news": news_id}
            return {"rank": rank, "best_rank": rank, "surpassed": surpassed}

    def _post_news(self, old, hall, rec, previous, rank, old_rank, track_id, extra):
        """One news post for a run that changed hall of fame positions."""
        extra = extra or {}
        # entries that were above the car before and are below it now
        above_before = {id(e) for e in old[:(old_rank - 1 if old_rank else len(old))]}
        passed = []
        for e in hall[rank:]:
            name = e.get("driver", "?")
            if id(e) in above_before and e.get("profile_id") != rec["profile_id"] and name not in passed:
                passed.append(name)
        post = {
            "id": uuid.uuid4().hex[:10], "date": rec["date"],
            "profile_id": rec["profile_id"], "driver": rec["driver"], "car_name": rec["car_name"],
            "track": str(track_id)[:80], "track_name": str(extra.get("track_name") or "")[:80],
            "status": str(extra.get("status") or "")[:20], "finished": rec["finished"],
            "time": rec["time"], "distance": rec["distance"],
            "rank": rank, "old_rank": old_rank, "passed": passed[:10], "taunt": None,
        }
        self.news.append(post)
        del self.news[:-NEWS_KEPT]
        _save(NEWS_FILE, self.news)
        return post["id"]

    def _below(self, hall, rec):
        """Other players with a place below the car's new place anywhere in the top 100."""
        mine_new = next(i for i, e in enumerate(hall) if e is rec)
        names = {p["id"]: p["name"] for p in self.profiles}
        pids = dict.fromkeys(e.get("profile_id") for e in hall[mine_new + 1:])
        return [{"id": pid, "name": names[pid]} for pid in pids if pid != rec["profile_id"] and pid in names]

    # ---------------- taunts ----------------

    def send_taunt(self, sender, track_id, track_name, text):
        """
        Leaves a message for the players the sender's latest time-trial run on
        this track put below their car (see submit_record).  One message
        per run: the list of targets is used up by sending.
        """
        text = str(text).strip()[:TAUNT_LENGTH]
        if not text:
            raise ValueError("The taunt is empty")
        with _lock:
            pending = self._pending.pop((sender, track_id), None) or {}
            targets = pending.get("to", [])
            if not targets:
                raise ValueError("There is nobody to taunt after that run")
            for target in targets:
                self.taunts.append({"id": uuid.uuid4().hex[:10], "from": sender, "to": target,
                                    "track": str(track_id)[:80], "track_name": str(track_name)[:80],
                                    "text": text, "date": time.time(), "read": False})
                received = [t for t in self.taunts if t["to"] == target]
                if len(received) > TAUNTS_KEPT:
                    self.taunts.remove(next((t for t in received if t["read"]), received[0]))
            _save(TAUNTS_FILE, self.taunts)
            post = next((n for n in self.news if n["id"] == pending.get("news")), None)
            if post:
                names = {p["id"]: p["name"] for p in self.profiles}
                post["taunt"] = {"text": text, "to": [names.get(t, "?") for t in targets]}
                _save(NEWS_FILE, self.news)
        return len(targets)

    def news_list(self):
        """Newest first."""
        return list(reversed(self.news))

    def taunts_for(self, profile_id):
        """Newest first, with the sender's current name."""
        names = {p["id"]: p["name"] for p in self.profiles}
        return [{**t, "from_name": names.get(t["from"], "?")}
                for t in reversed(self.taunts) if t["to"] == profile_id]

    def mark_taunts_read(self, profile_id):
        with _lock:
            for t in self.taunts:
                if t["to"] == profile_id:
                    t["read"] = True
            _save(TAUNTS_FILE, self.taunts)

    # ---------------- tracks ----------------

    def track_owner(self, track_id):
        """The profile id that saved a custom track, or None (built-in, or saved before logins)."""
        return next((t.get("owner") for t in self.tracks["custom"] if t["id"] == track_id), None)

    def save_track(self, definition, owner):
        """Store a seed-generated track definition (built by the front end)."""
        if not isinstance(definition, dict) or not isinstance(definition.get("id"), str):
            raise ValueError("Bad track definition")
        if len(json.dumps(definition)) > 4000:
            raise ValueError("Track definition too large")
        with _lock:
            old = next((t for t in self.tracks["custom"] if t["id"] == definition["id"]), None)
            # saving the same seed again keeps the first saver as the owner
            definition = {**definition, "owner": old.get("owner") if old else owner}
            self.tracks["custom"] = [t for t in self.tracks["custom"] if t["id"] != definition["id"]]
            self.tracks["custom"].append(definition)
            if definition["id"] in self.tracks["hidden"]:
                self.tracks["hidden"].remove(definition["id"])
            _save(TRACKS_FILE, self.tracks)

    def delete_track(self, track_id, builtin):
        """
        Custom tracks are removed together with their records.  Built-in
        tracks are only hidden (they can be restored), and keep their records.
        """
        with _lock:
            if builtin:
                if track_id not in self.tracks["hidden"]:
                    self.tracks["hidden"].append(track_id)
            else:
                self.tracks["custom"] = [t for t in self.tracks["custom"] if t["id"] != track_id]
                prefix = track_id + ".v"
                for key in [k for k in self.records if k.startswith(prefix) or k == track_id]:
                    del self.records[key]
                _save(RECORDS_FILE, self.records)
            _save(TRACKS_FILE, self.tracks)

    def restore_builtin_tracks(self):
        with _lock:
            self.tracks["hidden"] = []
            _save(TRACKS_FILE, self.tracks)
