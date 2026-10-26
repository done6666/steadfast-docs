export function requireTenant(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("tenantId is required");
  }
  return value;
}

export function sameTenant(left, right) {
  requireTenant(left);
  requireTenant(right);
  return left === right;
}
