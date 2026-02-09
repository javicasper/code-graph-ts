import { describe, it, expect } from "vitest";
import { resolveSymbol } from "../../domain/symbol-resolver.js";
import type { ParsedFile, ImportsMap } from "../../domain/types.js";

function makeParsedFile(overrides: Partial<ParsedFile> = {}): ParsedFile {
  return {
    path: "/src/main.ts",
    repoPath: "/project",
    lang: "typescript",
    functions: [],
    classes: [],
    imports: [],
    calls: [],
    variables: [],
    ...overrides,
  };
}

describe("resolveSymbol", () => {
  it("resolves symbol from imports + importsMap", () => {
    const importsMap: ImportsMap = new Map([
      ["Foo", [{ filePath: "/src/foo.ts", lineNumber: 1 }]],
    ]);
    const parsed = makeParsedFile({
      imports: [
        { name: "Foo", source: "./foo.js", lineNumber: 1 },
      ],
    });
    const result = resolveSymbol("Foo", parsed, importsMap);
    expect(result?.filePath).toBe("/src/foo.ts");
    expect(result?.lineNumber).toBe(1);
  });

  it("resolves symbol from global importsMap when not in local imports", () => {
    const importsMap: ImportsMap = new Map([
      ["Bar", [{ filePath: "/src/bar.ts", lineNumber: 5 }]],
    ]);
    const parsed = makeParsedFile();
    const result = resolveSymbol("Bar", parsed, importsMap);
    expect(result?.filePath).toBe("/src/bar.ts");
  });

  it("prefers external file over same file", () => {
    const importsMap: ImportsMap = new Map([
      ["Foo", [
        { filePath: "/src/main.ts", lineNumber: 10 },
        { filePath: "/src/foo.ts", lineNumber: 1 },
      ]],
    ]);
    const parsed = makeParsedFile({ path: "/src/main.ts" });
    const result = resolveSymbol("Foo", parsed, importsMap);
    expect(result?.filePath).toBe("/src/foo.ts");
  });

  it("returns undefined for unknown symbols", () => {
    const importsMap: ImportsMap = new Map();
    const parsed = makeParsedFile();
    const result = resolveSymbol("Unknown", parsed, importsMap);
    expect(result).toBeUndefined();
  });

  it("resolves symbol by alias", () => {
    const importsMap: ImportsMap = new Map([
      ["OriginalName", [{ filePath: "/src/original.ts", lineNumber: 1 }]],
    ]);
    const parsed = makeParsedFile({
      imports: [
        { name: "Alias", source: "./original.js", alias: "OriginalName", lineNumber: 1 },
      ],
    });
    const result = resolveSymbol("Alias", parsed, importsMap);
    expect(result?.filePath).toBe("/src/original.ts");
  });
});
