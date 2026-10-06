# Assets

Almost everything in the office is built in code (`src/client/scene/*.ts`) from
three.js shapes in the toon look — no files to download or license.

The exceptions are a few models in `src/client/assets/kenney/`, loaded by
`src/client/scene/props.ts` and recolored in the toon palette:

| Model | Where it is |
| --- | --- |
| `kitchenMicrowave.glb` | Kitchen counter — **E** pops popcorn |
| `toaster.glb`, `kitchenBlender.glb` | Kitchen counter |
| `ceilingFan.glb` | Over the kitchen tables and in the lobby |
| `radio.glb` | Reception desk — **E** for the news |
| `lampRoundFloor.glb` | By the lobby couch — **E** clicks it on and off |
| `bookcaseOpen.glb`, `coatRackStanding.glb`, `plantSmall2.glb` | The lobby |
| `trashcan.glb` | Your office — **E** for paper toss |

**Source:** [Furniture Kit](https://kenney.nl/assets/furniture-kit) (2.0) by
[Kenney](https://www.kenney.nl).
**License:** [Creative Commons Zero (CC0)](https://creativecommons.org/publicdomain/zero/1.0/) —
free for personal and commercial use, no attribution required (credited here
anyway). The kit's own license file is alongside the models.

The teddy bear and Pixel the cat are made in code.

## Adding more

Kenney's other kits are CC0 too. Drop a `.glb` into `src/client/assets/kenney/`
and place it with `model("name", { height, x, z, rotY })` in `props.ts` — it's
scaled to the height you give, stood on the floor, and its colors are swapped
for toon materials (`RECOLOR` maps Kenney's material names to the palette).
Kenney's models face +z.
