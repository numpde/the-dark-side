const { requireVersionedModuleContext } = await import(`./module-context.mjs${new URL(import.meta.url).search}`);
const { moduleSuffix } = requireVersionedModuleContext(import.meta, "Editor shell view module");
const { clearErrorText, showErrorText } = await import(`./error-presentation.mjs${moduleSuffix}`);
const {
  requireElement,
  guard,
  guardAsync,
} = await import(`./view-runtime.mjs${moduleSuffix}`);

export function createEditorShellView({
  reportError,
  onRoutingStateChange,
  onBikeabilityChange,
  onDirectionChange,
  onUnavailableUntilChange,
  onClear,
  onExport,
  onImportFile,
}) {
  const requireShellElement = (id) => requireElement(id, { errorElementId: "error-box" });
  const exportButton = requireShellElement("export-button");
  const importButton = requireShellElement("import-button");
  const importInput = requireShellElement("import-input");
  const wayHeading = requireShellElement("way-heading");
  const wayMeta = requireShellElement("way-meta");
  const bikeabilitySelect = requireShellElement("bikeability-select");
  const directionSelect = requireShellElement("direction-select");
  const unavailableUntilInput = requireShellElement("unavailable-until-input");
  const changeCount = requireShellElement("change-count");
  const clearButton = requireShellElement("clear-button");
  const errorBox = requireShellElement("error-box");
  const loadedRoutePolicyPath = requireShellElement("loaded-route-policy-path");
  const exportTargetPath = requireShellElement("export-target-path");
  const editorGraphAsset = requireShellElement("editor-graph-asset");
  const editorGeneratedAt = requireShellElement("editor-generated-at");
  const exportHint = requireShellElement("export-hint");
  const patchPreview = requireShellElement("patch-preview");
  const stateButtons = [...document.querySelectorAll(".state-button")];

  if (stateButtons.length === 0) {
    throw new Error("Missing required state buttons");
  }

  function showError(message) {
    showErrorText(errorBox, message);
  }

  function clearError() {
    clearErrorText(errorBox);
  }

  stateButtons.forEach((button) => {
    button.addEventListener("click", guard(reportError, "Failed to update routing state", () => {
      onRoutingStateChange(button.dataset.routingState);
    }));
  });

  bikeabilitySelect.addEventListener("change", guard(reportError, "Failed to update bikeability", () => {
    onBikeabilityChange(bikeabilitySelect.value === "" ? null : Number(bikeabilitySelect.value));
  }));

  directionSelect.addEventListener("change", guard(reportError, "Failed to update direction", () => {
    onDirectionChange(directionSelect.value);
  }));

  unavailableUntilInput.addEventListener("change", guard(reportError, "Failed to update availability", () => {
    onUnavailableUntilChange(unavailableUntilInput.value || null);
  }));

  clearButton.addEventListener("click", guard(reportError, "Failed to reset contig policy", onClear));
  exportButton.addEventListener("click", guard(reportError, "Failed to export route policy file", onExport));
  importButton.addEventListener("click", guard(reportError, "Failed to open import dialog", () => importInput.click()));

  importInput.addEventListener("change", guardAsync(reportError, "Failed to import route policy file", async () => {
    const [file] = importInput.files || [];
    if (!file) {
      return;
    }
    try {
      await onImportFile(file);
      clearError();
    } finally {
      importInput.value = "";
    }
  }));

  function update({
    feature,
    policy,
      loadedRoutePolicyLabel,
      canonicalRoutePolicyPath,
      editorGraphAssetId,
      editorGeneratedAtText,
      changedCount,
      routePolicyDocument,
      clearDisabled,
    }) {
    const disabled = !feature;

    wayHeading.textContent = feature
      ? feature.properties.way_names?.[0] || `Contig ${feature.properties.contig_id}`
      : "Select a contig";
    wayMeta.textContent = feature
      ? `#${feature.properties.contig_id} · ${Math.round(feature.properties.length_m)} m · ways ${feature.properties.way_ids.join(", ")}`
      : "";

    for (const button of stateButtons) {
      button.disabled = disabled;
      button.classList.toggle("is-active", policy.routingState === button.dataset.routingState);
    }
    bikeabilitySelect.disabled = disabled;
    bikeabilitySelect.value = policy.bikeability == null ? "" : String(policy.bikeability);
    directionSelect.disabled = disabled;
    directionSelect.value = policy.bicycleDirection;
    unavailableUntilInput.disabled = disabled;
    unavailableUntilInput.value = policy.unavailableUntil ?? "";
    clearButton.disabled = clearDisabled;

    changeCount.textContent = `${changedCount} changed`;
    loadedRoutePolicyPath.textContent = loadedRoutePolicyLabel;
    exportTargetPath.textContent = canonicalRoutePolicyPath;
    exportHint.innerHTML = `Export downloads a replacement for <code>${canonicalRoutePolicyPath}</code>.`;
    editorGraphAsset.textContent = editorGraphAssetId;
    editorGeneratedAt.textContent = editorGeneratedAtText;
    patchPreview.textContent = `${JSON.stringify(routePolicyDocument, null, 2)}\n`;
  }

  return {
    clearError,
    showError,
    update,
  };
}
