import type { ParsedFile, ImportsMap } from "./types.js";

/**
 * Resolve a symbol name to its definition location using:
 * 1. The parsed file's imports
 * 2. The global ImportsMap from pre-scanning
 *
 * Pure function — no side effects, no I/O.
 */
export function resolveSymbol(
  name: string,
  parsed: ParsedFile,
  importsMap: ImportsMap,
): { filePath: string; lineNumber: number } | undefined {
  // 1. Check imports of this file
  const imp = parsed.imports.find((i) => i.name === name || i.alias === name);
  if (imp) {
    const locations =
      importsMap.get(name) ??
      importsMap.get(imp.name) ??
      (imp.alias ? importsMap.get(imp.alias) : undefined);
    if (locations && locations.length > 0) {
      return locations[0];
    }
  }

  // 2. Check global importsMap
  const globalLocations = importsMap.get(name);
  if (globalLocations && globalLocations.length > 0) {
    // Prefer a different file over same file
    const external = globalLocations.find((l) => l.filePath !== parsed.path);
    return external ?? globalLocations[0];
  }

  return undefined;
}
