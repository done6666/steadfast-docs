export function minorUnits(value) {
  if (!Number.isInteger(value)) {
    throw new Error("amount must be integer minor units");
  }
  if (value < 0) {
    throw new Error("amount must not be negative");
  }
  return value;
}

export function addMinor(left, right) {
  return minorUnits(left) + minorUnits(right);
}

export function formatMinor(value, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(minorUnits(value) / 100);
}
