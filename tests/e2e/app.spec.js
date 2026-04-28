const { test, expect } = require("@playwright/test");

test("route app shell loads and route controls become usable", async ({ page }) => {
  let releaseNetwork;
  const networkGate = new Promise((resolve) => {
    releaseNetwork = resolve;
  });

  await page.route("**/generated/*.geojson", async (route) => {
    await networkGate;
    await route.continue();
  });

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Random bike routes" })).toBeVisible();
  await expect(page.locator("#map")).toBeVisible();

  const newRouteButton = page.locator("#new-route-button");
  const routeStrip = page.locator(".route-strip");
  const mapView = page.locator("#map");
  releaseNetwork();

  await expect(newRouteButton).toBeEnabled();
  await expect(page.locator("#scenario-label")).toContainText("km");
  await expect(page.locator("#download-link")).toHaveAttribute("href", /blob:/);

  await newRouteButton.click();
  await expect(routeStrip).toHaveClass(/is-stale/);
  await expect(mapView).toHaveClass(/is-stale/);
  await expect(page.locator("#scenario-label")).toContainText("km");
  await expect(page.locator("#scenario-label")).not.toContainText("Searching route");
  await expect(mapView).toHaveAttribute("data-loading-label", /Searching route/);
  await expect(page.locator("#download-link")).toHaveClass(/disabled/);
  await expect(newRouteButton).toBeDisabled();

  await expect(newRouteButton).toBeEnabled();
  await expect(routeStrip).not.toHaveClass(/is-stale/);
  await expect(mapView).not.toHaveClass(/is-stale/);
  await expect(page.locator("#download-link")).toHaveAttribute("href", /blob:/);
});

test("route app canonicalizes invalid query params to a valid scenario", async ({ page }) => {
  await page.goto("/?area=missing-area&start=bogus-start&end=bogus-end");

  await expect(page.getByRole("heading", { name: "Random bike routes" })).toBeVisible();
  await expect(page.locator("#new-route-button")).toBeEnabled();
  await expect(page.locator("#scenario-label")).toContainText("km");
  await expect(page).toHaveURL(/area=karura/);
  await expect(page).not.toHaveURL(/missing-area|bogus-start|bogus-end/);
});

test("route app canonicalizes invalid selector pairs to a valid scenario", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("#new-route-button")).toBeEnabled();

  const candidate = await page.evaluate(async () => {
    const manifest = await fetch("./generated/app-manifest.json", { cache: "no-store" }).then((response) => response.json());
    const areaId = document.querySelector("#area-select").value;
    const currentEnd = document.querySelector("#end-select").value;
    const area = manifest.areas.find((item) => item.id === areaId);
    for (const scenario of area.scenarios) {
      const invalidWithCurrentEnd = !area.scenarios.some(
        (item) => item.start_junction_id === scenario.start_junction_id && item.end_junction_id === currentEnd
      );
      if (invalidWithCurrentEnd) {
        const expected = area.scenarios.find((item) => item.start_junction_id === scenario.start_junction_id);
        return {
          newStart: scenario.start_junction_id,
          expectedEnd: expected.end_junction_id,
        };
      }
    }
    return null;
  });

  test.skip(!candidate, "all start/end pairs are already valid in this manifest");

  await page.locator("#start-select").selectOption(candidate.newStart);
  await expect(page.locator("#end-select")).toHaveValue(candidate.expectedEnd);
  await expect(page).toHaveURL(new RegExp(`start=${candidate.newStart}`));
  await expect(page).toHaveURL(new RegExp(`end=${candidate.expectedEnd}`));
  await expect(page.locator("#new-route-button")).toBeEnabled();
});

test("route app keeps mobile buttons separate from footer and footer near the viewport bottom", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 932 });
  await page.goto("/");

  await expect(page.locator("#new-route-button")).toBeEnabled();

  const layout = await page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) {
        throw new Error(`Missing element for selector: ${selector}`);
      }
      const box = element.getBoundingClientRect();
      return {
        top: box.top,
        bottom: box.bottom,
      };
    };
    return {
      viewportHeight: window.innerHeight,
      heading: rect("h1"),
      controls: rect(".controls-grid"),
      routePanel: rect(".route-panel"),
      buttons: rect(".button-row"),
      footer: rect(".app-footer"),
    };
  });

  expect(layout.controls.top - layout.heading.bottom).toBeGreaterThan(10);
  expect(layout.routePanel.top - layout.controls.bottom).toBeGreaterThan(10);
  expect(layout.buttons.top - layout.routePanel.bottom).toBeGreaterThan(10);
  expect(layout.footer.top - layout.buttons.bottom).toBeGreaterThan(24);
  expect(layout.viewportHeight - layout.footer.bottom).toBeLessThanOrEqual(32);
});

test("editor shell loads and resolves editor provenance", async ({ page }) => {
  await page.goto("/editor.html");

  await expect(page.getByRole("heading", { name: "Contig editor" })).toBeVisible();
  await expect(page.locator("#map")).toBeVisible();
  await expect(page.locator("#loaded-route-policy-path")).toHaveText("source/karura-route-policy.json");
  await expect(page.locator("#export-target-path")).toHaveText("source/karura-route-policy.json");
  await expect(page.locator("#export-hint")).toContainText("source/karura-route-policy.json");
  await expect(page.locator("#editor-graph-asset")).not.toHaveText("–");
  await expect(page.locator("#change-count")).toHaveText("0 changed");
  await expect(page.locator("#patch-preview")).toContainText("\"rules\":");
  const counts = await page.evaluate(async () => {
    const preview = JSON.parse(document.querySelector("#patch-preview").textContent);
    const source = await fetch("./source/karura-route-policy.json").then((response) => response.json());
    return {
      previewRuleCount: preview.rules.length,
      sourceRuleCount: source.rules.length,
    };
  });
  expect(counts.previewRuleCount).toBe(counts.sourceRuleCount);
});

test("editor shows default-excluded buffer contigs distinctly", async ({ page }) => {
  await page.addInitScript(() => {
    let leafletValue = null;
    Object.defineProperty(window, "L", {
      configurable: true,
      get() {
        return leafletValue;
      },
      set(value) {
        if (value && typeof value.map === "function" && !value.__capturedMapPatched) {
          const originalMap = value.map.bind(value);
          value.map = function(...args) {
            const map = originalMap(...args);
            window.__capturedLeafletMap = map;
            return map;
          };
          value.__capturedMapPatched = true;
        }
        leafletValue = value;
      },
    });
  });

  await page.goto("/editor.html");

  const state = await page.evaluate(() => {
    const map = window.__capturedLeafletMap;
    if (!map) {
      throw new Error("Leaflet map was not captured");
    }
    const geoLayers = [];
    map.eachLayer((layer) => {
      if (layer.feature && layer.feature.properties && layer.feature.properties.contig_id != null) {
        geoLayers.push(layer);
      }
    });
    const visibleById = new Map();
    const hitById = new Map();
    for (const layer of geoLayers) {
      const contigId = layer.feature.properties.contig_id;
      if (layer._events && layer._events.click) {
        hitById.set(contigId, layer);
      } else {
        visibleById.set(contigId, layer);
      }
    }
    for (const [contigId, hitLayer] of hitById.entries()) {
      const visibleLayer = visibleById.get(contigId);
      if (!visibleLayer) {
        continue;
      }
      if (visibleLayer.feature.properties.tags?.["local:boundary_zone"] !== "buffer") {
        continue;
      }
      hitLayer.fire("click");
      const activeState = [...document.querySelectorAll(".state-button")]
        .find((button) => button.classList.contains("is-active"))
        ?.dataset.routingState;
      const clearDisabled = document.querySelector("#clear-button").disabled;
      if (activeState === "exclude" && clearDisabled) {
        return {
          found: true,
          heading: document.querySelector("#way-heading").textContent,
          meta: document.querySelector("#way-meta").textContent,
          activeState,
          clearDisabled,
          visibleStyle: {
            color: visibleLayer.options?.color ?? null,
            dashArray: visibleLayer.options?.dashArray ?? null,
          },
        };
      }
    }
    return { found: false };
  });

  expect(state.found).toBe(true);
  expect(state.heading.length).toBeGreaterThan(0);
  expect(state.meta).toContain("buffer zone");
  expect(state.activeState).toBe("exclude");
  expect(state.clearDisabled).toBe(true);
  expect(state.visibleStyle.color).toBe("#c07a2d");
  expect(state.visibleStyle.dashArray).toBe("8 6");
});
