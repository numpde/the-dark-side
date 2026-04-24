# the-dark-side

Static route generator and GitHub Pages app for long, low-overlap bike routes through Karura Forest.

## Layout

```text
.
├── the_dark_side/        Python package
├── web/                  Static frontend and generated web data
├── data/                 Source map and derived graph data
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
  Downloads relation `13626194` from Overpass and writes:
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
- `the_dark_side.karura_routing`
  Shared graph/junction loaders plus route planners.
- `the_dark_side.elevation`
  Elevation clients plus helpers for graph and route profile summarization.
- `the_dark_side.plan_karura_route`
  Generates route candidates between curated junctions.
- `the_dark_side.benchmark_karura_routes`
  Benchmarks route planners across seeds and scenarios.
- `the_dark_side.render_karura_overlay`
  Renders debug overlays from `data/karura_map.json`.
- `the_dark_side.render_karura_figures`
  Renders curated figures from the figure catalog.
- `the_dark_side.render_karura_route`
  Renders planned route candidates on the aligned screenshot.
- `the_dark_side.export_karura_web_catalog`
  Exports the static frontend catalog plus a contig-network GeoJSON into `web/generated/`.

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

Build contigs from the ride graph:

```bash
python3 -m the_dark_side.build_karura_contigs
```

Apply local structural map patches:

```bash
python3 -m the_dark_side.apply_karura_patches
```

`build_karura_contigs` will prefer `data/karura_map_patched.json` when it exists, and fall back to `data/karura_map.json` otherwise.

Render the ride graph overlay:

```bash
python3 -m the_dark_side.render_karura_overlay --mode ride
```

Render the control overlay with all clipped ways:

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

Generate route candidates:

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

Generated route JSON assets go under `data/routes/`.

Render the top route from one of those assets:

```bash
python3 -m the_dark_side.render_karura_route data/routes/karura-route-naive-family_trail_west-to-kiambu_side_exit-seed7.json
```

Run the route diversity audit:

```bash
python3 -m unittest -v tests.test_route_diversity
```

Run the route benchmark summary:

```bash
python3 -m the_dark_side.benchmark_karura_routes --seed-start 1 --seed-end 10
```

This writes:
- `data/benchmarks/karura-route-benchmark.json`
- `data/benchmarks/karura-route-benchmark.md`

Export the static route catalog used by the frontend app:

```bash
python3 -m the_dark_side.export_karura_web_catalog --seed-start 1 --seed-end 6 --routes-per-scenario 12 --selection-window 36
```

This writes:
- `web/generated/catalog.json`
- `web/generated/karura-network.geojson`

Export the route catalog. If `data/karura_elevation.json` exists, elevation gain/loss and GPX `<ele>` values are derived from that local graph asset:

```bash
python3 -m the_dark_side.export_karura_web_catalog --seed-start 1 --seed-end 6 --routes-per-scenario 12 --selection-window 36
```

The graph elevation step uses the public Open Topo Data API with the global `mapzen` dataset and caches responses under `data/elevation_cache/`.
The frontend shows gain/loss and GPX downloads include `<ele>` values when those fields are present in the catalog.

Serve the frontend locally:

```bash
cd web
python3 -m http.server 8765
```

Then open:

```text
http://127.0.0.1:8765/
```

The page will:
- choose a random route for the selected start/end pair on each refresh
- render the route over OpenStreetMap with the Karura contig network faintly underneath
- generate a GPX download in the browser for the current route

GitHub Pages deployment is wired in `.github/workflows/deploy-pages.yml`. The workflow re-exports the static catalog and publishes `web/`.

## Local patch strategy

The repo treats OpenStreetMap as the upstream base layer, then applies a local override layer for product-specific corrections.

Use `curated/karura_map_patches.json` for structural fixes that should affect the normalized map before graph building. The current patch language supports:

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
2. `apply_karura_patches`
3. `build_karura_contigs`
4. `build_karura_elevation`
5. route planning / web export

Important: `curated/karura_map_patches.json` is not consumed directly by the GitHub Pages workflow. After changing map patches, regenerate and commit the derived assets before pushing:

```bash
python3 -m the_dark_side.apply_karura_patches
python3 -m the_dark_side.build_karura_contigs
python3 -m the_dark_side.build_karura_elevation --provider open-topo-data
python3 -m the_dark_side.export_karura_web_catalog --seed-start 1 --seed-end 6 --routes-per-scenario 12 --selection-window 36
```

## Data shape

`data/karura_map.json` contains:

- `meta`: download metadata and query info
- `boundary`: outer and inner rings for the Karura relation
- `nodes`: node id to `{lat, lon}`
- `ways`: way id to:
  - `tags`
  - `node_ids`
  - `segment_pairs`
  - `total_length_m`
  - `inside_length_m`
  - `bounds`

`segment_pairs` are the clipped segments whose midpoints fall inside the Karura boundary.

`data/karura_contigs.json` contains the collapsed ride graph:

- `crossings`: graph nodes with degree other than `2`
- `contigs`: maximal chains of rideable segments between crossings or dead ends

`curated/karura_map_patches.json` contains local structural edits layered on top of the downloaded map asset:

- `meta`: patchset metadata
- `patches`: ordered patch operations

`data/karura_map_patched.json` contains the derived patched map asset:

- `meta.source_asset_id`: the upstream normalized map asset
- `meta.patchset_id`: the local patch catalog used to derive it
- `meta.patchset_digest`: a content digest of the enabled applied patches
- `meta.applied_patch_ids`: the patch operations that were enabled and applied
- `nodes` / `ways`: the map payload after local structural edits

`curated/karura_junctions.json` is the manual layer for named junctions:

- `location` is the stable geographic point
- `asset_refs` contains graph-specific references (`graph_node_id`, `incident_contig_ids`) scoped to a particular generated asset
- `assets` records which generated graph file those references target

`curated/karura_figures.json` is the manual layer for presentation figures:

- `figures` contains stable figure ids
- each figure has `asset_refs` pointing at the generated assets it depends on
- figure items reference stable curated entities such as `junction_id`

`data/routes/*.json` contains generated route candidates:

- each route asset references the contig graph and junction catalog it was planned from
- `start` and `end` preserve the curated junction ids alongside the graph node ids
- `routes` contains ranked candidates with:
  - `contig_id_sequence`
  - `route_node_ids`
  - per-step traversal info, including whether a short connector was reused
  - `unique_length_m` and `overlap_length_m`

`web/generated/catalog.json` contains the static frontend bundle:

- `areas` contains the currently supported areas, starting with `karura`
- each area contains:
  - `junctions`
  - `route_families`
  - `scenarios`
  - a `network_path` to the generated GeoJSON overlay
- each `route_family` stores one canonical route geometry normalized up to reversal
- each scenario contains a prefiltered, diverse route pool as directional references into those shared route families
- route family records may also contain:
  - `elevation_gain_m`
  - `elevation_loss_m`
  - `elevation_min_m`
  - `elevation_max_m`
  - `elevations_m` aligned with `coordinates`
  - `elevation_profile` as `[distance_m, elevation_m]` pairs for charting
