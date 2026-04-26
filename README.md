# the-dark-side

Static GitHub Pages app and route-planning toolkit for long, low-overlap bike routes through Karura Forest.

## Layout

```text
.
├── the_dark_side/        Python package
├── source/               Canonical patch + catalog build inputs
├── web/                  Static frontend and published/generated web data
├── data/                 Baseline map, elevation cache, and derived graph data
├── curated/              Hand-edited junction and figure catalogs
├── assets/
│   ├── reference/        Screenshot + fitted viewport
│   ├── figures/          Tracked presentation figures
│   └── debug/            Regenerable debug overlays (ignored)
├── tests/                Route diversity audit
└── .github/workflows/    GitHub Pages deployment
```

## Python modules

- `the_dark_side.download_karura_map`
  Downloads the union of relations `13626194` (`Karura Forest`) and `15417497` (`Karura Playground`) from Overpass and writes:
  - `data/karura_overpass.json`
  - `data/karura_map.json`
- `the_dark_side.build_karura_contigs`
  Collapses the ride graph into maximal chains between crossings and writes:
  - `data/karura_contigs.json`
- `the_dark_side.apply_karura_patches`
  Applies local structural patches to the normalized map asset and writes:
  - `data/karura_map_patched.json`
- `the_dark_side.build_karura_elevation`
  Annotates the contig graph nodes with elevation values and writes:
  - `data/karura_elevation.json`
- `the_dark_side.junction_bindings`
  Resolves curated junction locations onto the current contig graph and writes:
  - `data/karura_junction_bindings.json`
- `the_dark_side.karura_routing`
  Shared graph/junction loaders plus route planners.
- `the_dark_side.elevation`
  Elevation clients plus helpers for graph and route profile summarization.
- `the_dark_side.plan_karura_route`
  Debug tool: generates one-off route candidates between curated junctions under `data/routes/`.
- `the_dark_side.benchmark_karura_routes`
  Benchmarks route planners across seeds and scenarios.
- `the_dark_side.render_karura_overlay`
  Renders debug overlays from `data/karura_map.json`.
- `the_dark_side.render_karura_figures`
  Renders curated figures from the figure catalog.
- `the_dark_side.render_karura_route`
  Debug tool: renders one-off planned route candidates on the aligned screenshot.
- `the_dark_side.export_karura_web_catalog`
  Exports the precomputed/debug route catalog plus the generated GeoJSON assets used by the web app and contig editor into `web/generated/`, and publishes the canonical `source/*.json` inputs into `web/source/`.
- `the_dark_side.rebuild_editor_assets`
  Rebuilds the patched map, contigs, derived junction bindings, and editor-facing assets.
- `the_dark_side.verify_editor_assets`
  Verifies that the editor-facing derived assets match the current canonical inputs.
- `the_dark_side.rebuild_app_assets`
  Rebuilds the editor assets, then exports the app-facing graph/manifests used by the browser-side planner.
- `the_dark_side.verify_app_assets`
  Verifies the editor assets, elevation cache binding, and published app assets.
- `the_dark_side.rebuild_all`
  Convenience wrapper that rebuilds the full editor + app stack; use `--with-elevation` to refresh the external cache first.
- `the_dark_side.verify_assets`
  Convenience wrapper around app verification.

## Setup

```bash
python3 -m pip install -r requirements.txt
```

The frontend is plain HTML/CSS/JS. No Node build step is required.

## Common commands

Download and normalize the map:

```bash
python3 -m the_dark_side.download_karura_map
```

By default the baseline inclusion region uses the topological outer shell of the Karura relations and ignores inner rings. Add `--respect-inner-rings` to treat relation holes as exclusions again, or `--no-fill-segment-gaps` to disable continuity repair along clipped ways for debugging.

Build contigs from the ride graph:

```bash
python3 -m the_dark_side.build_karura_contigs
```

Apply local structural map patches:

```bash
python3 -m the_dark_side.apply_karura_patches
```

This step also supports `--respect-inner-rings` and `--no-fill-segment-gaps` if you want patched way geometry to preserve stricter relation clipping behavior.

`build_karura_contigs` will prefer `data/karura_map_patched.json` when it exists, and fall back to `data/karura_map.json` otherwise.

Render the ride graph overlay:

```bash
python3 -m the_dark_side.render_karura_overlay --mode ride
```

Render the control overlay with all ways clipped to the current baseline boundary union:

```bash
python3 -m the_dark_side.render_karura_overlay --mode all
```

Render the contig overlay:

```bash
python3 -m the_dark_side.render_karura_overlay --mode contigs
```

Build the graph elevation asset:

```bash
python3 -m the_dark_side.build_karura_elevation --provider open-topo-data
```

Render the curated junction figure:

```bash
python3 -m the_dark_side.render_karura_figures --figure-id junctions_primary
```

Generate route candidates for debugging:

```bash
python3 -m the_dark_side.plan_karura_route --algorithm naive
python3 -m the_dark_side.plan_karura_route --algorithm beam
python3 -m the_dark_side.plan_karura_route --algorithm mcts
```

The current MCTS defaults are tuned toward longer coverage-heavy routes:

- `--mcts-iterations 640`
- `--mcts-rollout-top-k 3`
- `--mcts-rollout-samples 3`
- `--mcts-prior-weight 0.5`
- `--end-stop-unused-slack-m 400`
- `--mcts-loop-late-return-bonus 180`
- `--mcts-loop-overlap-penalty-per-m 4`

These one-off route assets are debug output only. The published app now composes routes in the browser from `web/generated/app-manifest.json` plus `web/generated/karura-network.geojson`.

Render the top route from one of those debug assets:

```bash
python3 -m the_dark_side.render_karura_route data/routes/karura-route-naive-family_trail_west-to-kiambu_side_exit-seed7.json
```

Run the route diversity audit:

```bash
python3 -m unittest -v tests.test_route_diversity
```

Run the GPX export and download-link tests:

```bash
node --test tests/test_gpx.mjs
node --test tests/test_editor_state.mjs
```

For local frontend development, install the dev-only Node tooling once:

```bash
npm install
```

Then use:

```bash
npm run serve:web
npm run test:web
npm run check:web
npm run test:e2e
npm run test:frontend
```

This does not change deployment; GitHub Pages still serves plain static files from `web/`.

Run the route benchmark summary:

```bash
python3 -m the_dark_side.benchmark_karura_routes --seed-start 1 --seed-end 10
```

This writes:
- `data/benchmarks/karura-route-benchmark.json`
- `data/benchmarks/karura-route-benchmark.md`

Rebuild the editor-facing derived assets from canonical inputs:

```bash
python3 -m the_dark_side.rebuild_editor_assets
```

This writes:
- `data/karura_map_patched.json`
- `data/karura_contigs.json`
- `data/karura_junction_bindings.json`
- `web/generated/karura-editor-network.geojson`
- `web/generated/editor-manifest.json`
- `web/source/karura-map-patches.json`
- `web/source/catalog_build.json`

Rebuild the published route app assets:

```bash
python3 -m the_dark_side.rebuild_app_assets
```

This writes:
- `web/generated/karura-network.geojson`
- `web/generated/app-manifest.json`

Rebuild including a refreshed elevation cache:

```bash
python3 -m the_dark_side.rebuild_all --with-elevation
```

Verify editor-facing derived assets:

```bash
python3 -m the_dark_side.verify_editor_assets
```

Verify the published app assets:

```bash
python3 -m the_dark_side.verify_app_assets
```

The browser-planner build parameters live in `source/catalog_build.json`. The published app uses a bounded seeded beam planner in a Web Worker; `rebuild_app_assets` exports the graph and the planner config needed by that worker.

The graph elevation step uses the public Open Topo Data API with the global `mapzen` dataset and caches responses under `data/elevation_cache/`.
The frontend shows gain/loss and GPX downloads include `<ele>` values when those fields are present on the generated route graph.

Serve the frontend locally:

```bash
cd web
python3 -m http.server 8765
```

Then open:

```text
http://127.0.0.1:8765/
```

The visual contig editor lives at:

```text
http://127.0.0.1:8765/editor.html
```

The page will:
- choose a fresh seeded route for the selected start/end pair on each refresh
- render the route over OpenStreetMap with the Karura contig network faintly underneath
- generate a GPX download in the browser for the current route

The editor will:
- load the current patch file automatically
- let you mark baseline transport contigs (all kept `highway=*` plus `amenity=parking`) as `default`, `include`, or `exclude`
- annotate `bikeability` and allowed bike direction
- annotate contigs as unavailable until a specific date
- export a replacement for `source/karura-map-patches.json`

GitHub Pages deployment is wired in `.github/workflows/deploy-pages.yml`. The workflow rebuilds the editor/app assets, verifies provenance, and publishes `web/`.
It also runs on a daily schedule so `unavailable until` dates can expire out of the published browser-planner graph without a manual push.

## Local patch strategy

The repo treats OpenStreetMap as the upstream base layer, then applies a local override layer for product-specific corrections.

Use `source/karura-map-patches.json` for structural fixes and contig policy that should affect the normalized map before graph building. The current patch language supports:

- `add_way`
- `remove_way`
- `update_way_tags`
- `replace_way_geometry`

This is the right place for:

- missing local paths
- local-only geometry fixes
- access or surface tag overrides
- removing paths that should not exist in the local product graph

Use `curated/karura_routing_overrides.json` for time-varying routing knowledge that should sit on top of the contig graph rather than alter the base map. This catalog is reserved for:

- temporary closures
- construction
- bikeability penalties
- connector eligibility

The intended build order is:

1. `download_karura_map`
2. `rebuild_editor_assets`
3. `build_karura_elevation` when you intentionally refresh the external cache
4. `rebuild_app_assets`

Canonical inputs:

- `data/karura_map.json`
- `source/karura-map-patches.json`
- `source/catalog_build.json`
- `curated/karura_junctions.json`
- `curated/karura_figures.json`

Pinned external cache:

- `data/karura_elevation.json`

Everything else in `data/` and `web/generated/` is derived. After changing a canonical input, regenerate and verify before pushing:

```bash
python3 -m the_dark_side.rebuild_editor_assets
python3 -m the_dark_side.verify_editor_assets
python3 -m the_dark_side.rebuild_app_assets
python3 -m the_dark_side.verify_app_assets
```

## Data shape

`data/karura_map.json` contains:

- `meta`: download metadata and query info
- `boundary`: outer and inner rings for the Karura relation union
- `nodes`: node id to `{lat, lon}`
- `ways`: way id to:
  - `tags`
  - `node_ids`
  - `segment_pairs`
  - `total_length_m`
  - `inside_length_m`
  - `bounds`

`segment_pairs` are the kept segments after boundary clipping. By default the baseline uses the union of the relations' outer shells, ignoring inner rings so relation holes do not punch topological breaks into the route graph. A segment is kept if either endpoint is inside that baseline region, and short internal gaps between kept runs on the same way are filled by default to preserve topology near the boundary.

`data/karura_contigs.json` contains the collapsed baseline transport graph used for routing:

- `crossings`: graph nodes with degree other than `2`
- `contigs`: maximal chains of kept baseline transport segments between crossings or dead ends

`source/karura-map-patches.json` contains local structural edits and contig policy layered on top of the downloaded map asset:

- `meta`: patchset metadata
- `patches`: ordered patch operations

`source/catalog_build.json` contains the canonical browser-planner build parameters:

- planner list
- seed range
- candidate limits
- selection window
- all planner tuning values that affect the published app graph/manifests

`data/karura_map_patched.json` contains the derived patched map asset:

- `meta.source_asset_id`: the upstream normalized map asset
- `meta.patchset_id`: the local patch catalog used to derive it
- `meta.patchset_digest`: a content digest of the enabled applied patches
- `meta.applied_patch_ids`: the patch operations that were enabled and applied
- `nodes` / `ways`: the map payload after local structural edits

`curated/karura_junctions.json` is the manual layer for named junctions:

- `location` is the stable geographic point

`data/karura_junction_bindings.json` contains the derived graph binding for those stable junctions:

- `meta.graph_asset_id` identifies the contig graph it was built against
- `bindings[*].graph_node_id` is the resolved graph node
- `bindings[*].incident_contig_ids` are the contigs touching that node

`curated/karura_figures.json` is the manual layer for presentation figures:

- `figures` contains stable figure ids
- figure items reference stable curated entities such as `junction_id`

`data/routes/karura-route-catalog.json` remains available as a precomputed/debug route bundle from `export_karura_web_catalog.py`, but it is no longer used by the published app and is not part of the Pages artifact.

`web/generated/app-manifest.json` contains the live route-app bootstrap payload:

- `planner` contains the browser-side algorithm id, the ride-network asset path, and bounded planner config
- `areas` contains the currently supported areas, starting with `karura`
- each area contains:
  - `junctions`
  - `scenarios`
  - `bounds`

`web/generated/karura-network.geojson` contains the contig graph used by the browser planner:

- one feature per ride-graph contig
- `node_ids`, `endpoint_node_ids`, `way_ids`, `tags`, and `length_m`
- `elevations_m` aligned with the feature geometry when the pinned elevation cache matches the current graph

`web/generated/editor-manifest.json` and `web/generated/app-manifest.json` expose the active graph asset ids, patch digest, build config digest, and generated timestamps so stale assets are visible in the UI and CI.
