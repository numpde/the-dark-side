SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

.PHONY: help install build preview serve check test test-python test-web test-e2e test-frontend verify \
	rebuild-editor rebuild-app rebuild-all ci shell run

help:
	@printf '%s\n' \
		'the-dark-side dev targets' \
		'All dev/test/build commands run through ./scripts/dev-container.sh.' \
		'' \
		'Setup:' \
		'  make install                 Build toolchain images and run npm ci in the install container.' \
		'' \
		'Build/preview:' \
		'  make build                   Rebuild app assets and bundle dist.' \
		'  make preview                 Serve existing dist at http://127.0.0.1:8765/.' \
		'  make serve                   Build, then serve dist at http://127.0.0.1:8765/.' \
		'' \
		'Checks:' \
		'  make check                   Run JS source checks.' \
		'  make test                    Run Python, Node, and Playwright tests.' \
		'  make test-python             Run Python unittest discovery.' \
		'  make test-web                Run Node source tests.' \
		'  make test-e2e                Build dist and run Playwright tests.' \
		'  make test-frontend           Run Node checks/tests plus Playwright.' \
		'  make verify                  Verify generated editor/app/dist assets.' \
		'  make ci                      Run the contained release/Pages check lane.' \
		'' \
		'Generated assets:' \
		'  make rebuild-editor          Rebuild editor-facing generated assets.' \
		'  make rebuild-app             Rebuild app-facing generated assets.' \
		'  make rebuild-all             Rebuild all generated data/assets.' \
		'' \
		'Container access:' \
		'  make shell                   Open a shell in the locked container.' \
		'  make run CMD="python -m ..." Run an arbitrary command in the locked container.'

install:
	./scripts/dev-container.sh --install

build:
	./scripts/dev-container.sh build:web

preview:
	./scripts/dev-container.sh preview:web

serve:
	./scripts/dev-container.sh serve:web

check:
	./scripts/dev-container.sh check:web

test:
	./scripts/dev-container.sh test

test-python:
	./scripts/dev-container.sh test:python

test-web:
	./scripts/dev-container.sh test:web

test-e2e:
	./scripts/dev-container.sh test:e2e

test-frontend:
	./scripts/dev-container.sh test:frontend

verify:
	./scripts/dev-container.sh verify

rebuild-editor:
	./scripts/dev-container.sh rebuild:editor

rebuild-app:
	./scripts/dev-container.sh rebuild:app

rebuild-all:
	./scripts/dev-container.sh rebuild:all

ci:
	./scripts/dev-container.sh ci

shell:
	./scripts/dev-container.sh shell

run:
	@if [ -z "$${CMD:-}" ]; then \
		printf 'usage: make run CMD="python -m the_dark_side.verify_app_assets"\n' >&2; \
		exit 2; \
	fi
	./scripts/dev-container.sh run $${CMD}
