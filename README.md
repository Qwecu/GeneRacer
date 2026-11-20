# GeneRacer

Breed race cars, then race them. The genetics model comes from TenderFace: a
diploid genome (two chromosomes of `(dominance, value)` alleles), single-point
crossover per parent, and a small mutation rate.

## Run

```
py server.py            # opens http://localhost:8766
py server.py --no-browser
```

Python 3 standard library only. Players, cars, tracks and records are saved in
`data/` (created on first run with one player and six random starter cars).
Delete that folder to start over. To use a different save folder, set the
`GENERACER_DATA` environment variable to its path.

## Gameplay

- **Players**: pick the current player in the top-right corner, or create,
  rename and delete players there. Every player has their own garage, and a new
  player starts with six random cars. Deleting a player deletes their cars;
  records they set are kept. The browser remembers which player was last
  selected.
- **Garage**: the current player's cars. Generate a random car, tick two of
  your cars and breed them, or click a car to see its stats and full genotype.
  Retired cars can still breed.
- **Race (hotseat)**: 1-6 players drive one after another on the same keyboard.
  Each row picks a player and one of that player's own cars, and each player
  drives in their own colour. Earlier runs appear as ghosts. Finishers rank by
  time; if nobody finishes, the player who got furthest wins.
- **Time trial**: the current player drives one of their cars alone. Every run
  is offered to the track's **hall of fame**, a top-ten list shared by all
  players. Each player and car can hold one place, replaced only by a better
  run. Finishers rank by time, everyone else by distance. Every hall of fame
  run keeps its ghost; the "Ghosts" choice next to the car picker decides which
  drive along: top 3 plus your best with this car (default), number 1 only,
  your best only, the whole top 10, or none. Ghost labels are in each player's
  colour. Every track card shows who currently holds number 1.
  The Hall of fame tab lists all tracks. Hotseat races do not count.
- Controls: arrow keys; Space to start or continue; M to toggle sound; Esc to
  give up a run. Steering in reverse works like a real car: Right while
  reversing swings the tail right and the nose left.

### Tracks

Tracks are generated from a seed, so a preset always has the same shape and
records stay comparable. There are two shapes:

- **Sprint**: point to point. The setup card shows whether it has more left or
  right turns.
- **Circuit**: a closed loop driven for several laps. A right-handed circuit
  turns right almost all the time, so a car with strong `steer right` genes has
  an advantage there, and the reverse on left-handed circuits.

Each track combines a time of day (day, dusk, night), weather (dry, rain, fog,
snow) and a landscape (meadow, forest, desert, snow). At dusk and night only the
car's headlights (genetic reach) and the pit lights cut through the dark. Fog
limits sight to a short radius around the car. Rain uses the tyre-compound
gene; snow uses it too, with a further penalty.

**Your own tracks.** Type a seed (any number or word) above the track list,
optionally a name, and optionally force the shape, time of day or weather;
everything else comes from the seed, and the same seed always gives the same
track. "Create and save track" stores it in `data/tracks.json`, and it keeps its
own record like the built-in tracks. The last card is an unsaved random track:
"New random track" rolls another, "Save track" keeps it.

**Deleting tracks.** Every card has a Delete button. A saved custom track is
removed together with its record. A built-in track is only hidden (its record
is kept), and a "Restore removed built-in tracks" button brings them back.

### Refuelling

Pit lanes branch off the road every 0.6-1.2 km, separated from it by an
island. Steer into the lane on the entry ramp and stop at the yellow pump area
to refuel.

The range on one tank varies a lot between cars: in normal driving roughly
0.9-6 km for 90% of random cars, with rare cars below 0.5 km or above 10 km.
Some cars die before the first pit lane, others can skip several. The garage
shows each car's estimated range; holding the gas down all the time burns
more than the estimate assumes.

### Sound

Each car has a signature engine sound and refuelling sound, synthesised from
five sound genes: engine note (pitch), engine timbre (soft, buzzy or harsh),
cylinders (2-12; few cylinders throb, many hum), gulp pitch and gulp rhythm.
The engine roars while you press the gas, and the car gulps while it drinks at
the pumps. Children inherit their parents' sounds like any other trait. Use the
"Hear engine" and "Hear refuelling" buttons in the garage to listen.

A run ends at the finish, when the car is out of fuel and
standing still, when it is wrecked (durability 0), when it reaches its lifetime
kilometres, after 40 s without progress, or on Esc.

Every kilometre driven is added to the car's odometer. When the odometer
reaches the car's genetic lifespan, the car retires.

## Genes (traits.py)

37 loci, each expressed in one of four ways: `dominant` (the allele with higher
dominance wins), `avg` (additive), `low` (the weaker allele wins), `high`
(one strong allele is enough).

| Trait | Genes | Notes |
|---|---|---|
| Looks | length, width, hue, saturation, lightness, stripes, stripe hue, spoiler, wheels, cabin, headlight colour | Body size also affects weight and durability |
| Weight | chassis mass, armour, body size | Fuel adds 0.75 kg/L at run time |
| Durability | armour, body size | Wall impacts cost HP |
| Engine power (acceleration) | engine A (avg) + engine B (dominant) | Linked: adjacent on the chromosome |
| Top speed | top speed A (avg) + B (high) | |
| Headlights | strength (high) | How far you see on night tracks |
| Friction | tyre grip (dry), tyre compound (share kept in the wet) | Limits acceleration, braking and cornering |
| Steering | steer left, steer right (separate) | |
| Forward / back | engine power; back power (brake and reverse) | |
| Reflexes | forward, back, left, right (separate) | Input delay 20-350 ms per command |
| Fuel | tank size (dominant, 12-90 L), efficiency (avg, 0.5-1.6) | Wide range on purpose |
| Drag | drag | Speed lost when coasting |
| Lifespan | lifespan A (low-dominant) + B (avg) | 20-200 km |
| Sound | engine note, engine timbre, cylinders, gulp pitch, gulp rhythm | Cosmetic, heard in races and the garage |

## Files

- `genome.py`: diploid genome, expression modes, crossover and mutation
- `traits.py`: gene map and genotype-to-phenotype decoding
- `garage.py`: JSON persistence for cars, odometers and records
- `server.py`: HTTP server and JSON API
- `static/`: front end (`app.js` menus, `race.js` physics and rendering, `sound.js` genetic sounds,
  `tracks.js` seeded tracks, `carart.js` car drawing)
