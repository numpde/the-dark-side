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
  releaseNetwork();

  await expect(newRouteButton).toBeEnabled();
  await expect(page.locator("#scenario-label")).toContainText("km");
  await expect(page.locator("#download-link")).toHaveAttribute("href", /blob:/);
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
