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

test("editor shell loads and resolves editor provenance", async ({ page }) => {
  await page.goto("/editor.html");

  await expect(page.getByRole("heading", { name: "Contig editor" })).toBeVisible();
  await expect(page.locator("#map")).toBeVisible();
  await expect(page.locator("#loaded-patch-path")).toHaveText("source/karura-map-patches.json");
  await expect(page.locator("#export-target-path")).toHaveText("source/karura-map-patches.json");
  await expect(page.locator("#export-hint")).toContainText("source/karura-map-patches.json");
  await expect(page.locator("#editor-graph-asset")).not.toHaveText("–");
  await expect(page.locator("#patch-preview")).toContainText("\"patches\":");
});
