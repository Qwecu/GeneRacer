"""
Gene map and phenotype decoding.

GENE_MAP documents every locus: what it influences and how its two alleles
are expressed.  express_car() turns a genome into two dicts:

    looks - everything the renderer needs to draw the car
    stats - everything the physics needs to drive it

Some traits are polygenic (engine power, top speed, lifespan read two loci)
and some loci are pleiotropic (armour and body size raise durability but
also add weight), so there is no single "best" allele to select for.
"""

from genome import CarGenome

# index -> (name, expression mode, what it does)
GENE_MAP = [
    ("body length",        "avg",      "Longer body: more weight, more durability"),
    ("body width",         "avg",      "Wider body: more weight, more durability"),
    ("paint hue",          "dominant", "Body colour"),
    ("paint saturation",   "dominant", "How vivid the paint is"),
    ("paint lightness",    "avg",      "Dark to light paint"),
    ("stripe pattern",     "dominant", "None, centre stripe, twin stripes, side stripes"),
    ("stripe hue",         "dominant", "Stripe colour"),
    ("spoiler",            "dominant", "Rear wing size (cosmetic)"),
    ("wheel size",         "avg",      "Wheel size (cosmetic)"),
    ("cabin shape",        "dominant", "Bubble, canopy or short cab"),
    ("armour",             "avg",      "Durability, but also weight"),
    ("chassis mass",       "avg",      "Base weight of the chassis"),
    ("engine A",           "avg",      "Engine power (additive part)"),
    ("engine B",           "dominant", "Engine power (dominant part, linked to engine A)"),
    ("top speed A",        "avg",      "Maximum speed (additive part)"),
    ("top speed B",        "high",     "Maximum speed (one fast allele is enough)"),
    ("headlight strength", "high",     "How far the lights reach at night"),
    ("headlight colour",   "dominant", "Warm yellow to cool blue (cosmetic)"),
    ("tyre grip",          "avg",      "Friction in dry conditions"),
    ("tyre compound",      "dominant", "How much grip survives in the wet"),
    ("steer left",         "dominant", "Turning rate to the left"),
    ("steer right",        "dominant", "Turning rate to the right"),
    ("back power",         "avg",      "Brake force and reverse power"),
    ("reflex forward",     "dominant", "Reaction time to the gas pedal"),
    ("reflex back",        "dominant", "Reaction time to the brake"),
    ("reflex left",        "dominant", "Reaction time to steering left"),
    ("reflex right",       "dominant", "Reaction time to steering right"),
    ("fuel tank",          "dominant", "Fuel tank size (one allele decides, so sizes vary a lot)"),
    ("fuel efficiency",    "avg",      "How far a litre goes"),
    ("lifespan A",         "low",      "Lifetime kilometres (a weak allele is dominant)"),
    ("lifespan B",         "avg",      "Lifetime kilometres (additive part)"),
    ("drag",               "avg",      "Air resistance: low drag keeps speed when coasting"),
    ("engine note",        "avg",      "Pitch of the engine sound"),
    ("engine timbre",      "dominant", "Soft, buzzy or harsh engine sound"),
    ("cylinders",          "dominant", "How lumpy the engine sounds (2 to 12 cylinders)"),
    ("gulp pitch",         "avg",      "Pitch of the refuelling gulps"),
    ("gulp rhythm",        "dominant", "How fast the car gulps fuel (sound only)"),
]

assert len(GENE_MAP) == 37

# Displayed stats: key, label, unit, lo, hi, higher_is_better
TRAIT_INFO = [
    ("weight",        "Weight (empty)",   "kg",   700, 1600, False),
    ("power",         "Engine power",     "kW",    70,  370, True),
    ("power_to_weight", "Power / weight", "kW/t",  50,  400, True),
    ("max_speed",     "Top speed",        "km/h", 150,  340, True),
    ("durability",    "Durability",       "HP",    40,  200, True),
    ("light_range",   "Headlight reach",  "m",     20,  110, True),
    ("grip",          "Dry grip",         "",    0.55, 1.15, True),
    ("wet_grip",      "Wet grip",         "",    0.30, 1.00, True),
    ("steer_left",    "Steer left",       "deg/s",  80,  220, True),
    ("steer_right",   "Steer right",      "deg/s",  80,  220, True),
    ("back_power",    "Brake / reverse",  "",     180,  600, True),
    ("react_forward", "Gas reflex",       "ms",    20,  350, False),
    ("react_back",    "Brake reflex",     "ms",    20,  350, False),
    ("react_left",    "Left reflex",      "ms",    20,  350, False),
    ("react_right",   "Right reflex",     "ms",    20,  350, False),
    ("tank",          "Fuel tank",        "L",     12,   90, True),
    ("efficiency",    "Fuel efficiency",  "",    0.50, 1.60, True),
    ("range_km",      "Est. range (tank)", "km",  0.3, 10.0, True),
    ("drag",          "Drag",             "",    0.60, 1.40, False),
    ("lifespan_km",   "Lifespan",         "km",    20,  200, True),
]

KMH_PER_PX_S = 0.9     # 1 px = 0.25 m in the race world
M_PER_PX = 0.25


def express_car(genome: CarGenome):
    e = genome.express

    def g(i):
        return e(i, GENE_MAP[i][1])

    # ---------------- looks ----------------
    length = 34 + 16 * g(0)
    width = 16 + 8 * g(1)
    looks = {
        "length": round(length, 2),
        "width": round(width, 2),
        "hue": round(360 * g(2)),
        "sat": round(25 + 70 * g(3)),
        "light": round(28 + 40 * g(4)),
        "stripe": min(3, int(g(5) * 4)),
        "stripe_hue": round(360 * g(6)),
        "spoiler": 0 if g(7) < 0.35 else round((g(7) - 0.35) / 0.65, 2),
        "wheel": round(0.8 + 0.5 * g(8), 2),
        "cabin": min(2, int(g(9) * 3)),
        "light_hue": round(40 + 180 * g(17)),
    }

    # ---------------- stats ----------------
    size = 0.5 * g(0) + 0.5 * g(1)
    armour = g(10)
    weight = 650 + 450 * g(11) + 350 * armour + 250 * size
    power = 70 + 300 * (0.6 * g(12) + 0.4 * g(13))
    max_speed_px = 170 + 210 * (0.5 * g(14) + 0.5 * g(15))

    def reflex(i):
        return round(20 + 330 * (1 - g(i)))

    stats = {
        "weight": round(weight),
        "power": round(power),
        "power_to_weight": round(power / weight * 1000),
        "max_speed": round(max_speed_px * KMH_PER_PX_S),
        "max_speed_px": round(max_speed_px, 1),
        "durability": round(40 + 120 * armour + 40 * size),
        "light_range": round((80 + 360 * g(16)) * M_PER_PX),
        "light_range_px": round(80 + 360 * g(16)),
        "grip": round(0.55 + 0.6 * g(18), 3),
        "wet_grip": round(0.3 + 0.7 * g(19), 3),
        "steer_left": round(80 + 140 * g(20)),
        "steer_right": round(80 + 140 * g(21)),
        "back_power": round(180 + 420 * g(22)),
        "react_forward": reflex(23),
        "react_back": reflex(24),
        "react_left": reflex(25),
        "react_right": reflex(26),
        "tank": round(12 + 78 * g(27), 1),
        "efficiency": round(0.5 + 1.1 * g(28), 3),
        "lifespan_km": round(20 + 180 * (0.5 * g(29) + 0.5 * g(30)), 1),
        "drag": round(0.6 + 0.8 * g(31), 3),
    }
    stats["range_km"] = estimate_range_km(stats)

    # ---------------- sound ----------------
    sound = {
        "engine_hz": round(45 + 95 * g(32), 1),
        "timbre": round(g(33), 3),
        "cylinders": [2, 3, 4, 6, 8, 12][min(5, int(g(34) * 6))],
        "gulp_hz": round(180 + 720 * g(35)),
        "gulp_rate": round(3 + 9 * g(36), 2),
    }
    return looks, stats, sound


def estimate_range_km(stats):
    """
    Rough distance on one full tank in normal racing.  Mirrors the fuel burn in
    static/race.js: burn = 2.1 * (0.5 + 0.5*power/220) * sqrt(mass/1300) / efficiency
    litres per second of throttle, plus 0.03 L/s idle.
    """
    mass = stats["weight"] + stats["tank"] * 0.75 / 2
    burn = 2.1 * (0.5 + 0.5 * stats["power"] / 220) * (mass / 1300) ** 0.5 / stats["efficiency"]
    seconds = stats["tank"] / (burn * 0.45 + 0.03)   # gas pedal held ~45% of the time in real driving
    speed_px = 0.75 * stats["max_speed_px"]
    return round(seconds * speed_px * M_PER_PX / 1000, 2)


def genotype_table(genome: CarGenome):
    """Per-locus view for the UI: both alleles and which one is expressed."""
    rows = []
    for i, (name, mode, desc) in enumerate(GENE_MAP):
        a1 = genome.chromosome1[i]
        a2 = genome.chromosome2[i]
        rows.append({
            "index": i,
            "name": name,
            "mode": mode,
            "desc": desc,
            "a1": list(a1),
            "a2": list(a2),
            "expressed": round(getattr(genome, mode)(i)),
        })
    return rows


def trait_info_json():
    return [
        {"key": k, "label": l, "unit": u, "lo": lo, "hi": hi, "higher_better": hb}
        for k, l, u, lo, hi, hb in TRAIT_INFO
    ]
