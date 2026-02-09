import { describe, it, expect, vi } from "vitest";
import { AnalyzeCodeService } from "../../application/analyze-code.js";
import type { GraphReader } from "../../domain/ports.js";

function createMockGraphReader(returnRows: Record<string, unknown>[] = []): GraphReader {
  return {
    runQuery: vi.fn().mockResolvedValue(returnRows),
  };
}

describe("AnalyzeCodeService", () => {
  it("findCallers runs correct query and maps results", async () => {
    const reader = createMockGraphReader([
      {
        caller_name: "main",
        caller_path: "/src/main.ts",
        caller_line: 10,
        call_line: 5,
      },
    ]);
    const service = new AnalyzeCodeService(reader);
    const results = await service.findCallers("greet", 20);
    expect(results).toHaveLength(1);
    expect(results[0].callerName).toBe("main");
    expect(results[0].callerPath).toBe("/src/main.ts");
    expect(reader.runQuery).toHaveBeenCalledWith(
      expect.stringContaining("CALLS"),
      expect.objectContaining({ name: "greet", limit: 20 }),
    );
  });

  it("findCallees maps results correctly", async () => {
    const reader = createMockGraphReader([
      { callee_name: "log", callee_path: "/lib.ts", callee_line: 3, call_line: 7 },
    ]);
    const service = new AnalyzeCodeService(reader);
    const results = await service.findCallees("main", 10);
    expect(results[0].calleeName).toBe("log");
  });

  it("classHierarchy returns hierarchy chains", async () => {
    const reader = createMockGraphReader([
      { hierarchy: ["Dog", "Animal", "Object"] },
    ]);
    const service = new AnalyzeCodeService(reader);
    const results = await service.classHierarchy("Dog", 5);
    expect(results[0]).toEqual(["Dog", "Animal", "Object"]);
  });

  it("deadCode returns functions with no callers", async () => {
    const reader = createMockGraphReader([
      { name: "unused", path: "/src/unused.ts", line_number: 1 },
    ]);
    const service = new AnalyzeCodeService(reader);
    const results = await service.deadCode(50);
    expect(results[0].name).toBe("unused");
  });

  it("mostComplexFunctions filters by repoPath", async () => {
    const reader = createMockGraphReader([]);
    const service = new AnalyzeCodeService(reader);
    await service.mostComplexFunctions(10, "/myrepo");
    expect(reader.runQuery).toHaveBeenCalledWith(
      expect.stringContaining("repo_path"),
      expect.objectContaining({ repoPath: "/myrepo" }),
    );
  });

  it("calculateComplexity filters by path when provided", async () => {
    const reader = createMockGraphReader([
      { name: "foo", path: "/src/foo.ts", line_number: 1, complexity: 5 },
    ]);
    const service = new AnalyzeCodeService(reader);
    const results = await service.calculateComplexity("foo", "/src/foo.ts");
    expect(results[0].complexity).toBe(5);
    expect(reader.runQuery).toHaveBeenCalledWith(
      expect.stringContaining("f.path = $path"),
      expect.objectContaining({ name: "foo", path: "/src/foo.ts" }),
    );
  });
});
