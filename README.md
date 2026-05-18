# the-dark-side

Random bike routes through Karura Forest, plus the data/build tooling behind the published app.

## App

- Live app: `https://numpde.github.io/the-dark-side/`
- Local app: `http://127.0.0.1:8765/`
- Local editor: `http://127.0.0.1:8765/editor.html`

What the app does:
- generates long, low-overlap routes in the browser
- shows the route over OpenStreetMap
- exports GPX in the browser

What the editor does:
- shows the current candidate graph, including default-excluded buffer segments
- edits canonical route policy
- exports a replacement for `source/karura-route-policy.json`

## Repo

```text
.
├── the_dark_side/        Python package
├── source/               Canonical structural patches, route policy, planner config
├── curated/              Canonical junction + figure catalogs
├── data/                 Downloaded map, elevation cache, and derived graph assets
├── web/                  Frontend source
├── dist/                 Built Pages artifact
├── assets/               Screenshot, viewport, and figure/debug outputs
├── tests/                Python, Node, and Playwright tests
└── .github/workflows/    CI and Pages deployment
```

## Architecture

The project has three layers:

1. Canonical source
   - `source/karura-map-patches.json`
   - `source/karura-route-policy.json`
   - `source/catalog_build.json`
   - `curated/karura_junctions.json`
   - `curated/karura_figures.json`

2. Derived data
   - patched map
   - contig graphs
   - route-policy bindings
   - junction bindings
   - generated app/editor manifests

3. Built frontend artifact
   - `dist/`
   - bundled hashed JS
   - generated HTML
   - copied runtime JSON/GeoJSON

GitHub Pages now serves `dist/`, not raw `web/` source files.

## Setup

Build the locked dev toolchain images and install Node dependencies through the install container:

```bash
make install
```

Host-local `pip`, `npm ci`, `pytest`, `npx`, and direct `python -m ...` workflows are not supported for this repo. Use `make ...`, `npm run ...`, or `./scripts/dev-container.sh ...`; each route enters the locked container first. The normal check lane runs with no runtime network, dropped Linux capabilities, `no-new-privileges`, a read-only container root filesystem, and PID/RAM limits. External data refreshes must opt in with `./scripts/dev-container.sh --allow-network ...`.

## Main workflows

### Build and preview the site

```bash
make serve
```

This:
- rebuilds the Python-derived app assets
- bundles the frontend into `dist/`
- serves `dist/` on port `8765`

If `dist/` already exists and you just want to serve it:

```bash
make preview
```

### Rebuild the data/app stack

Rebuild editor-facing assets:

```bash
make rebuild-editor
```

Rebuild app-facing assets:

```bash
make rebuild-app
```

Rebuild everything, optionally refreshing elevation first:

```bash
./scripts/dev-container.sh --allow-network rebuild:all --with-elevation
```

### Verify

Verify canonical inputs against derived editor assets:

```bash
./scripts/dev-container.sh run python -m the_dark_side.verify_editor_assets
```

Verify app assets:

```bash
./scripts/dev-container.sh run python -m the_dark_side.verify_app_assets
```

Verify the built `dist/` artifact:

```bash
./scripts/dev-container.sh run python -m the_dark_side.verify_web_dist
```

Run all asset verifiers:

```bash
make verify
```

### Test

Source-level frontend checks:

```bash
make check
make test-web
```

Browser tests against `dist/`:

```bash
make test-e2e
```

All Python tests:

```bash
make test-python
```

Selected Python tests:

```bash
./scripts/dev-container.sh run python -m unittest -v tests.test_route_diversity
./scripts/dev-container.sh run python -m unittest -v tests.test_cli_entrypoints
```

## Canonical editing model

### Structural map patches

Use `source/karura-map-patches.json` for map-layer fixes that should affect normalization before graph building.

Current patch types:
- `add_way`
- `remove_way`
- `update_way_tags`
- `replace_way_geometry`

Use this file for:
- missing local paths
- geometry fixes
- local tag overrides
- removing paths that should not exist in the normalized map

### Route policy

Use `source/karura-route-policy.json` for routing policy:
- include / exclude
- bikeability
- bicycle direction
- `unavailable_until`

This is canonical source. It is rebound onto the current ride graph during rebuild.

### Bindings

These are derived, not source of truth:
- `data/karura_route_policy_bindings.json`
- `data/karura_junction_bindings.json`

Rebuilds should fail if canonical rules or curated junctions can no longer be resolved cleanly onto the refreshed graph.

## Boundary model

The normalized map uses two zones:

- `A`: core boundary
- `B`: buffered boundary

Segments in `B - A`:
- are preserved in the editor/app background graph
- are tagged `local:boundary_zone=buffer`
- are excluded from routing by default
- can be explicitly re-included via route policy

This keeps near-boundary connectors visible and editable without silently making them routable.

## Useful modules

Core pipeline:
- `the_dark_side.download_karura_map`
- `the_dark_side.apply_karura_patches`
- `the_dark_side.build_karura_contigs`
- `the_dark_side.build_karura_elevation`
- `the_dark_side.junction_bindings`
- `the_dark_side.route_policy`
- `the_dark_side.web_assets`

App/editor rebuild + verification:
- `the_dark_side.rebuild_editor_assets`
- `the_dark_side.rebuild_app_assets`
- `the_dark_side.rebuild_all`
- `the_dark_side.verify_editor_assets`
- `the_dark_side.verify_app_assets`
- `the_dark_side.verify_web_dist`

Offline debug/oracle tools:
- `the_dark_side.plan_karura_route`
- `the_dark_side.benchmark_karura_routes`
- `the_dark_side.export_karura_web_catalog`
- `the_dark_side.render_karura_overlay`
- `the_dark_side.render_karura_route`
- `the_dark_side.render_karura_figures`

The published app does not use the Python route generators. It plans routes in the browser from:
- `web/generated/app-manifest.json`
- `web/generated/karura-network.geojson`

## Data outputs

Important derived files:

- `data/karura_map.json`
  - normalized OSM snapshot
- `data/karura_map_patched.json`
  - normalized map after structural patches
- `data/karura_contigs.json`
  - derived contig graph
- `data/karura_route_policy_bindings.json`
  - canonical route policy projected onto the current graph
- `data/karura_junction_bindings.json`
  - curated junctions projected onto the current graph
- `web/generated/karura-editor-network.geojson`
  - editor/background network
- `web/generated/karura-network.geojson`
  - planner network
- `web/generated/editor-manifest.json`
  - editor bootstrap payload
- `web/generated/app-manifest.json`
  - app bootstrap payload

## Deployment

GitHub Pages deployment is defined in `.github/workflows/deploy-pages.yml`.

On push to `main`, CI:
1. checks out the repo
2. installs Python, Node, and Playwright
3. runs source checks and tests
4. rebuilds Python-derived assets
5. bundles the frontend into hashed files in `dist/`
6. verifies source assets and the built `dist/` artifact
7. runs Playwright against `dist/`
8. uploads and deploys `dist/` to GitHub Pages

The public URL stays:

`https://numpde.github.io/the-dark-side/`
