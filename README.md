# Laggan — a living Highland village

**Live demo:** https://lukaszkujawa.github.io/laggan/ (needs a WebGPU browser, e.g. recent Chrome/Edge; falls back to WebGL2).
Every push to `main` is built and published by `.github/workflows/pages.yml`.

A real-time 3D simulation of Laggan (Badenoch, Scottish Highlands). It runs in the browser on three.js **WebGPU** (TSL node materials) and has a full day/night cycle, changing weather, and foliage that responds to wind, rain and snow, with an optional storybook "fantasy" look.

**Rendering:** deferred-style MRT pass → screen-space ray-traced GI + AO (SSGI) → screen-space reflections (wet roads, river, windows) → temporal AA (TRAA) → bloom, sun shafts and a cinematic grade (AgX, split toning, night blue shift, vignette, grain). Cascaded shadow maps cover ~500 m. Leaves and grass use subsurface-scattering materials. Trees close to the camera use the full-detail scanned LODs; distant ones use baked multi-view impostors with normals. Needs a WebGPU browser (current Chrome/Edge); without WebGPU three.js falls back to WebGL2, which I haven't tested.

## Run

```bash
npm install
npm run prepare-assets   # one-off: ./assets (Blender export) -> ./public/assets (web GLBs)
npm run dev              # http://localhost:5173
```

The first load streams about 270 MB of models and instance data. Building the tree impostors takes a few more seconds after that.

## What's simulated

| | |
|---|---|
| **Sun & moon** | Real solar position for 57°N (mid-September). The sky gradient, sunrise/sunset glow, stars, Milky Way, a moon with phases and, on clear nights, an aurora over the northern hills. |
| **Weather** | Clear, Fair, Overcast, Rain, Storm (lightning bolts, thunder), Haar (valley mist) and Snow. Presets blend into each other, and **auto** mode runs Highland weather on its own. |
| **Surfaces** | Ground, roads and roofs get wet in rain and dry out afterwards. Puddles form on roads, with rain ripples. Snow settles on upward-facing surfaces (roofs, walls, trees, grass) and melts again. |
| **Woodland** | The 92k scanned plants are densified at load time to about 2× (new trees, shrubs and ground plants seeded around existing ones, mixing species; roads, water, buildings and gardens are masked out). Each plant gets its own tint, and about a fifth of the birches and bracken show early-autumn colour. `?density=0.5` / `?no=scatter` to tune. |
| **Foliage** | 92k scanned plants, drawn as instances with dithered LOD crossfades and baked multi-view impostors for distant trees. Wind uses travelling gust fronts plus per-leaf flutter. Grass (1.5M patches, streamed around the camera) bends in gusts, is weighed down by rain, flattens under snow and parts around you in Walk mode. |
| **Night lights** | Each window follows its own schedule: evening lights, early risers, night owls, the odd flickering TV. Street lamps warm up from sodium red, with misty light cones in fog and rain and point lights on the nearest lamps. |
| **Fantasy** (slider) | Bioluminescent grass tips and heather, glowing berries in the trees, fireflies and violet wisps, glints in the water at night, sunlit thistle-down by day, extra colour and bloom. |
| **Water** | Flow-mapped River Spey and burns, using the exported `_FLOW`/`_SHORE` data. Peaty colour, foam at the banks, sky and lamp reflections, rain rings. |
| **Sound** | Synthesised wind, rain, river murmur, thunder, birdsong by day and an owl at night. |

## Controls

- **Orbit** (default): drag to rotate, right-drag to pan, scroll to zoom, WASD to move.
- **Walk**: double-click to capture the mouse. WASD to walk, Shift to run, Space to jump.
- **Fly**: WASD, Q/E for down/up, Shift to go faster.
- **Tour**: a slow automatic drift through the village.
- Keys: `1–7` weather presets · `T` pause time · `[` `]` step the clock · `C` cycle camera · `H` hide the panel.

Quality presets (Low → Ultra) control grass radius, vegetation distances, shadow resolution, MSAA and pixel ratio. If the frame rate stays below ~24 fps, the app drops one level by itself until you pick a quality by hand.

## Code map

```
scripts/prepare-assets.mjs   glTF -> GLB, WebP textures, heavy LODs dropped, meshopt far LODs for rocks/props/saplings;
                             re-run after every Blender export (unchanged models are skipped; --force rebuilds all).
                             If an export has no grass table, the previous one is kept (.cache/) and re-seated on the
                             new terrain. Models listed in scene.json without files are skipped with a warning.
src/veg/species.js           what each exported model is: behaviour (wind/shadows/impostor), draw range, scatter group
src/core/                    TSL uniforms, noise, wind, height fog, weather material layer, heightfield
src/env/                     sun/moon maths, sky shader, weather state, environment (light, fog, IBL)
src/world/                   terrain/buildings/roads (weathering, windows), water, street lamps
src/veg/                     instanced vegetation + impostor baker, streamed grass
src/fx/                      rain/snow/splashes/fireflies/leaves/lightning (separate FX pass), post pipeline
src/controls.js, audio.js, ui/
```

Materials are three.js node materials (TSL), so shadows, IBL and point lights keep working while the node graphs add wind, wetness, snow, window lights and height fog. Debug flags: `?no=veg,grass,water,lamps,fx,post,ssgi,ssr,scatter` switches subsystems off; `?fps=0` uncaps the frame rate. `scripts/dev/perf.mjs` measures frame times in a visible Chrome window.

Performance note: instance buffers must not use `DynamicDrawUsage` on three's WebGPU backend; it re-uploads such buffers on every draw call.
