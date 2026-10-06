# Assets

Almost everything in the office is built in code (`src/client/scene/*.ts`) from
three.js shapes in the toon look — no files to download or license.

The exceptions are a few models in `src/client/assets/kenney/`, loaded by
`src/client/scene/props.ts` (the first batch) and `src/client/scene/extras.ts`
(the second) and drawn in the toon look.

## Furniture Kit — `kenney/`

| Model | Where it is |
| --- | --- |
| `kitchenMicrowave.glb` | Kitchen counter — **E** pops popcorn |
| `toaster.glb`, `kitchenBlender.glb` | Kitchen counter |
| `ceilingFan.glb` | Over the kitchen tables and in the lobby |
| `radio.glb` | Reception desk — **E** for the news |
| `lampRoundFloor.glb` | By the lobby couch — **E** clicks it on and off |
| `bookcaseOpen.glb`, `coatRackStanding.glb`, `plantSmall2.glb` | The lobby |
| `trashcan.glb` | Your office — **E** for paper toss |
| `speaker.glb` | Either side of the lounge TV; by the piano on floor 2 |
| `pottedPlant.glb` | The stand-up room's corners; floor 2 |
| `rugRound.glb`, `loungeDesignChair.glb`, `lampSquareFloor.glb` | Floor 2's lounge and library |

**Source:** [Furniture Kit](https://kenney.nl/assets/furniture-kit) (2.0).

## Mini Arcade — `kenney/arcade/`

| Model | Where it is |
| --- | --- |
| `vending-machine.glb` | The open office, east wall by the lounge — **E** for a snack (a short speed boost) |
| `air-hockey.glb` | The game room — **E** for a quick match |
| `pinball.glb` | The game room, north wall — **E** to launch a ball (your best is kept) |

**Source:** [Mini Arcade](https://kenney.nl/assets/mini-arcade) (1.2).

## Food Kit — `kenney/food/`

| Model | Where it is |
| --- | --- |
| `donut-sprinkles.glb` | On a stand-up room standing table — **E** to grab one (a speed boost; restocked a few minutes after they're gone) |
| `cup-coffee.glb` | On the other standing table |

**Source:** [Food Kit](https://kenney.nl/assets/food-kit) (2.0).

## Nature Kit — `kenney/nature/`

| Model | Where it is |
| --- | --- |
| `plant_bush.glb` | The plaza's corners, the lawn out front |
| `flower_redA.glb`, `flower_yellowA.glb` | A ring round the fountain |
| `tree_pineRoundA.glb` | Along the pitch's east side |
| `log_stack.glb` | By the campfire out back |
| `rock_smallA.glb` | Round the pond |

**Source:** [Nature Kit](https://kenney.nl/assets/nature-kit) (2.1).

## License

Every kit is by [Kenney](https://www.kenney.nl) under
[Creative Commons Zero (CC0)](https://creativecommons.org/publicdomain/zero/1.0/) —
free for personal and commercial use, no attribution required (credited here
anyway). Each kit's own license file is alongside its models.

The teddy bear, Pixel the cat and Biscuit the dog are made in code.

## Adding more

Kenney's other kits are CC0 too. Put a Furniture Kit `.glb` in
`src/client/assets/kenney/`, or another kit's in a folder of its own (with that
kit's `Textures/colormap.png` copied in as `colormap.png` — the newer kits paint
every model from that one texture), and place it with
`model("folder/name", { height, x, z, rotY })` — it's scaled to the height you
give (or `width`, for flat things like rugs), stood on the floor, and its
materials are swapped for toon ones (`RECOLOR` in `props.ts` maps the Furniture
Kit's material names to the palette; textured models keep their texture).
Kenney's models face +z. Models in the open office, game room and stand-up room
go in the props' group; the grounds' and floor 2's have groups of their own in
`extras.ts`, shown only when you can see them.
