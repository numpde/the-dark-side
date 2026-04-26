function requireContract(context, label, predicate) {
  if (!predicate()) {
    throw new Error(`${context} is missing valid ${label}`);
  }
}

export function requireObject(value, label, options = {}) {
  const { context = null } = options;
  if (context) {
    requireContract(
      context,
      label,
      () => value && typeof value === "object" && !Array.isArray(value),
    );
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

export function requireArray(value, label, options = {}) {
  const { context = null } = options;
  if (context) {
    requireContract(context, label, () => Array.isArray(value));
    return value;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

export function requireString(value, label, options = {}) {
  const { context = null } = options;
  if (context) {
    requireContract(context, label, () => typeof value === "string" && value.length > 0);
    return value;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function requireFiniteNumber(value, label, options = {}) {
  const { context = null, coerce = false } = options;
  const numeric = coerce ? Number(value) : value;
  if (context) {
    requireContract(
      context,
      label,
      () => typeof numeric === "number" && Number.isFinite(numeric),
    );
    return numeric;
  }
  if (typeof numeric !== "number" || !Number.isFinite(numeric)) {
    throw new Error(`${label} must be a finite number`);
  }
  return numeric;
}

export function requireInteger(value, label, options = {}) {
  const { context = null, coerce = false } = options;
  const numeric = coerce ? Number(value) : value;
  if (context) {
    requireContract(context, label, () => Number.isInteger(numeric));
    return numeric;
  }
  if (!Number.isInteger(numeric)) {
    throw new Error(`${label} must be an integer`);
  }
  return numeric;
}

export function requireCoordinatePair(value, label, options = {}) {
  const pair = requireArray(value, label, options);
  if (pair.length !== 2) {
    throw new Error(`${label} must be a [lon, lat] coordinate pair`);
  }
  return [
    requireFiniteNumber(pair[0], `${label}[0]`, options),
    requireFiniteNumber(pair[1], `${label}[1]`, options),
  ];
}

export function requireIntegerArray(value, label, options = {}) {
  const items = requireArray(value, label, options);
  return items.map((item, index) => requireInteger(item, `${label}[${index}]`, options));
}
