export function defineProvider({ name, charge }) {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("provider name is required");
  }
  if (typeof charge !== "function") {
    throw new Error("provider charge must be a function");
  }
  return Object.freeze({ name, charge });
}
