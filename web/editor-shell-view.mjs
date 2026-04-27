const { requireVersionedModuleContext } = await import(`./module-context.mjs${new URL(import.meta.url).search}`);
const { moduleSuffix } = requireVersionedModuleContext(import.meta, "Editor shell view module");
const { clearErrorText, showErrorText } = await import(`./error-presentation.mjs${moduleSuffix}`);

function findErrorBox() {
  return document.getElementById("error-box");
}

function requireElement(id) {
  const element = document.getElementById(id);
  if (!element) {
    const message = `Missing required page element: #${id}`;
    const fallbackErrorBox = findErrorBox();
    if (fallbackErrorBox) {
      fallbackErrorBox.textContent = message;
      fallbackErrorBox.classList.remove("hidden");
    }
    console.error(message);
    throw new Error(message);
  }
  return element;
}

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
  const exportButton = requireElement("export-button");
  const importButton = requireElement("import-button");
  const importInput = requireElement("import-input");
  const wayHeading = requireElement("way-heading");
  const wayMeta = requireElement("way-meta");
  const bikeabilitySelect = requireElement("bikeability-select");
  const directionSelect = requireElement("direction-select");
  const unavailableUntilInput = requireElement("unavailable-until-input");
  const changeCount = requireElement("change-count");
  const clearButton = requireElement("clear-button");
  const errorBox = requireElement("error-box");
  const loadedPatchPath = requireElement("loaded-patch-path");
  const exportTargetPath = requireElement("export-target-path");
  const editorGraphAsset = requireElement("editor-graph-asset");
  const editorGeneratedAt = requireElement("editor-generated-at");
  const exportHint = requireElement("export-hint");
  const patchPreview = requireElement("patch-preview");
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

  function guard(fn, context) {
    return (...args) => {
      try {
        return fn(...args);
      } catch (error) {
        reportError(error, context);
        return undefined;
      }
    };
  }

  function guardAsync(fn, context) {
    return async (...args) => {
      try {
        return await fn(...args);
      } catch (error) {
        reportError(error, context);
        return undefined;
      }
    };
  }

  stateButtons.forEach((button) => {
    button.addEventListener("click", guard(() => {
      onRoutingStateChange(button.dataset.routingState);
    }, "Failed to update routing state"));
  });

  bikeabilitySelect.addEventListener("change", guard(() => {
    onBikeabilityChange(bikeabilitySelect.value === "" ? null : Number(bikeabilitySelect.value));
  }, "Failed to update bikeability"));

  directionSelect.addEventListener("change", guard(() => {
    onDirectionChange(directionSelect.value);
  }, "Failed to update direction"));

  unavailableUntilInput.addEventListener("change", guard(() => {
    onUnavailableUntilChange(unavailableUntilInput.value || null);
  }, "Failed to update availability"));

  clearButton.addEventListener("click", guard(onClear, "Failed to reset contig policy"));
  exportButton.addEventListener("click", guard(onExport, "Failed to export patch file"));
  importButton.addEventListener("click", guard(() => importInput.click(), "Failed to open import dialog"));

  importInput.addEventListener("change", guardAsync(async () => {
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
  }, "Failed to import patch file"));

  function update({
    feature,
    policy,
    loadedPatchLabel,
    canonicalPatchPath,
    editorGraphAssetId,
    editorGeneratedAtText,
    changedCount,
    patchDocument,
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
    loadedPatchPath.textContent = loadedPatchLabel;
    exportTargetPath.textContent = canonicalPatchPath;
    exportHint.innerHTML = `Export downloads a replacement for <code>${canonicalPatchPath}</code>.`;
    editorGraphAsset.textContent = editorGraphAssetId;
    editorGeneratedAt.textContent = editorGeneratedAtText;
    patchPreview.textContent = `${JSON.stringify(patchDocument, null, 2)}\n`;
  }

  return {
    clearError,
    showError,
    update,
  };
}
