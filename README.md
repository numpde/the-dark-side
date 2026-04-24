# Karura Map Pipeline

Small local pipeline for:

1. downloading Karura OSM data from Overpass
2. normalizing it into a JSON map structure
3. collapsing the ride graph into contigs
4. rendering debug overlays on the reference screenshot
5. planning long low-overlap routes between curated junctions
6. exporting a frontend-only static route catalog for GitHub Pages

## Files

- `download_karura_map.py`
  Downloads relation `13626194` (`Karura Forest`) and writes:
  - `data/karura_overpass.json`
  - `data/karura_map.json`
- `build_karura_contigs.py`
  Collapses the ride graph into maximal chains between crossings and writes:
  - `data/karura_contigs.json`
- `karura_routing.py`
  Shared graph/junction loaders plus route planners
- `curated/karura_junctions.json`
  Hand-picked named junctions for UI/routing use
- `curated/karura_figures.json`
  Hand-picked figure definitions with asset-scoped references
- `plan_karura_route.py`
  Generates route candidates between curated junctions
  - `naive`: simple stochastic rollout
  - `beam`: higher-quality beam search with seeded final-route selection from a diverse candidate pool
  - `mcts`: Monte Carlo tree search with tuned multi-rollout evaluation and loop-aware late-return reward for stronger coverage while keeping seed diversity
- `benchmark_karura_routes.py`
  Benchmarks route planners across seeds and scenarios and writes JSON + Markdown summaries
- `render_karura_overlay.py`
  Renders overlays from `data/karura_map.json`
- `render_karura_figures.py`
  Renders curated figures from the figure catalog
- `render_karura_route.py`
  Renders planned route candidates on the aligned screenshot
- `export_karura_web_catalog.py`
  Exports a static frontend catalog plus a contig-network GeoJSON into `app/generated/`
- `app/`
  Zero-build static frontend that picks a random precomputed route on load and builds GPX in the browser
- `karura-source-screenshot.png`
  Reference screenshot used for visual alignment
- `karura-viewport.json`
  Pre-fit viewport parameters used to project the map onto the screenshot

## Setup

```bash
python3 -m pip install -r requirements.txt
```

The static frontend itself does not need a Node build step. It is plain HTML/CSS/JS plus generated JSON assets.

## Usage

Download and normalize the map:

```bash
python3 download_karura_map.py
```

Render the ride graph overlay:

```bash
python3 render_karura_overlay.py --mode ride
```

Render the control overlay with all clipped ways:

```bash
python3 render_karura_overlay.py --mode all
```

Build contigs from the ride graph:

```bash
python3 build_karura_contigs.py
```

Render the contig overlay:

```bash
python3 render_karura_overlay.py --mode contigs
```

Render the curated junction figure:

```bash
python3 render_karura_figures.py --figure-id junctions_primary
```

Generate a naive proof-of-concept route between the two curated junctions:

```bash
python3 plan_karura_route.py --algorithm naive
```

Generate a beam-search route between the same junctions:

```bash
python3 plan_karura_route.py --algorithm beam
```

Generate an MCTS route between the same junctions:

```bash
python3 plan_karura_route.py --algorithm mcts
```

The current MCTS defaults are tuned toward longer coverage-heavy routes:

- `--mcts-iterations 640`
- `--mcts-rollout-top-k 3`
- `--mcts-rollout-samples 3`
- `--mcts-prior-weight 0.5`
- `--end-stop-unused-slack-m 400`
- `--mcts-loop-late-return-bonus 180`
- `--mcts-loop-overlap-penalty-per-m 4`

Both commands write JSON route assets under `data/routes/`.

Render the top route from one of those assets:

```bash
python3 render_karura_route.py data/routes/karura-route-naive-family_trail_west-to-kiambu_side_exit-seed7.json
```

Run the route diversity audit:

```bash
python3 -m unittest -v tests.test_route_diversity
```

Run the route benchmark summary:

```bash
python3 benchmark_karura_routes.py --seed-start 1 --seed-end 10
```

This writes:
- `data/benchmarks/karura-route-benchmark.json`
- `data/benchmarks/karura-route-benchmark.md`

Export the static route catalog used by the frontend app:

```bash
python3 export_karura_web_catalog.py --seed-start 1 --seed-end 6 --routes-per-scenario 12 --selection-window 36
```

This writes:
- `app/generated/catalog.json`
- `app/generated/karura-network.geojson`

Serve the frontend locally:

```bash
cd app
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

GitHub Pages deployment is wired in `.github/workflows/deploy-pages.yml`. The workflow re-exports the static catalog and publishes the `app/` directory.

## Data Shape

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

`segment_pairs` are the clipped segments whose midpoints fall inside the Karura boundary. The renderer uses those directly rather than reparsing the OSM relation.

`data/karura_contigs.json` contains the collapsed ride graph:

- `crossings`: graph nodes with degree other than `2`
- `contigs`: maximal chains of rideable segments between crossings or dead ends

`curated/karura_junctions.json` is the manual layer for named junctions that we want to preserve even if the generated graph is rebuilt.

- `location` is the stable geographic point
- `asset_refs` contains graph-specific references (`graph_node_id`, `incident_contig_ids`) scoped to a particular generated asset
- `assets` records which generated graph file those references target

`curated/karura_figures.json` is the manual layer for presentation figures.

- `figures` contains stable figure ids
- each figure has `asset_refs` pointing at the generated assets it depends on
- figure items reference stable curated entities such as `junction_id`

`data/routes/*.json` contains generated route candidates.

- each route asset references the contig graph and junction catalog it was planned from
- `start` and `end` preserve the curated junction ids alongside the graph node ids
- `routes` contains ranked candidates with:
  - `contig_id_sequence`
  - `route_node_ids`
  - per-step traversal info, including whether a short connector was reused
  - `unique_length_m` and `overlap_length_m`

`app/generated/catalog.json` contains the static frontend bundle.

- `areas` contains the currently supported areas, starting with `karura`
- each area contains:
  - `junctions`
  - `scenarios`
  - a `network_path` to the generated GeoJSON overlay
- each scenario contains a prefiltered, diverse route pool with full route coordinates ready for map rendering or GPX export
