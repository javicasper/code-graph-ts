/**
 * Type guard for Neo4j Integer objects that have a .toNumber() method.
 */
function isNeo4jInteger(val: unknown): val is { toNumber(): number } {
  return val != null && typeof val === "object" && typeof (val as Record<string, unknown>).toNumber === "function";
}

/**
 * Convert a Neo4j value (possibly Integer) to a JS number, or undefined if null.
 */
export function toNumber(val: unknown): number | undefined {
  if (val == null) return undefined;
  if (typeof val === "number") return val;
  if (isNeo4jInteger(val)) return val.toNumber();
  return Number(val);
}

/**
 * Extract count from a single-row query result like `[{ c: Integer(5) }]`.
 * Returns 0 if the result is empty or null.
 */
export function toCount(rows: Record<string, unknown>[]): number {
  return toNumber(rows[0]?.c) ?? 0;
}
