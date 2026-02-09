import { describe, it, expect, vi, beforeEach } from "vitest";
import { IndexCodeService } from "../../application/index-code.js";
import { InMemoryJobStore } from "../../application/job-store.js";
import type { GraphRepository, FileSystem, Logger } from "../../domain/ports.js";
import type { LanguageParser, ParsedFile, ImportsMap } from "../../domain/types.js";

function createMockGraph(): GraphRepository {
  return {
    verifyConnectivity: vi.fn().mockResolvedValue(undefined),
    ensureSchema: vi.fn().mockResolvedValue(undefined),
    runQuery: vi.fn().mockResolvedValue([]),
    mergeNode: vi.fn().mockResolvedValue(undefined),
    mergeRelationship: vi.fn().mockResolvedValue(undefined),
    deleteFileNodes: vi.fn().mockResolvedValue(undefined),
    deleteRepository: vi.fn().mockResolvedValue(undefined),
    deleteAll: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockFs(files: Record<string, string> = {}): FileSystem {
  return {
    readFile: vi.fn((path: string) => files[path] ?? ""),
    exists: vi.fn((path: string) => path in files),
    glob: vi.fn().mockResolvedValue(Object.keys(files)),
  };
}

function createMockParser(parsedFile?: Partial<ParsedFile>): LanguageParser {
  const defaultParsed: ParsedFile = {
    path: "/project/test.js",
    repoPath: "",
    lang: "javascript",
    functions: [{ name: "foo", lineNumber: 1, endLine: 1, args: [], cyclomaticComplexity: 1 }],
    classes: [],
    imports: [],
    calls: [],
    variables: [],
    ...parsedFile,
  };

  return {
    supportedExtensions: [".js"],
    languageName: "javascript",
    parse: vi.fn().mockReturnValue(defaultParsed),
    preScan: vi.fn().mockReturnValue(new Map()),
  };
}

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  };
}

describe("IndexCodeService", () => {
  let graph: GraphRepository;
  let fs: FileSystem;
  let parser: LanguageParser;
  let jobStore: InMemoryJobStore;
  let logger: Logger;
  let service: IndexCodeService;

  beforeEach(() => {
    graph = createMockGraph();
    fs = createMockFs({ "/project/test.js": 'export function foo() {}' });
    parser = createMockParser();
    jobStore = new InMemoryJobStore();
    logger = createMockLogger();
    service = new IndexCodeService(graph, fs, [parser], jobStore, logger);
  });

  it("indexes a directory and creates a job", async () => {
    const jobId = await service.indexDirectory("/project");
    expect(jobId).toMatch(/^job_/);
    const job = jobStore.get(jobId);
    expect(job?.status).toBe("completed");
    expect(job?.filesTotal).toBe(1);
  });

  it("calls ensureSchema", async () => {
    await service.indexDirectory("/project");
    expect(graph.ensureSchema).toHaveBeenCalled();
  });

  it("parses files via parser", async () => {
    await service.indexDirectory("/project");
    expect(parser.parse).toHaveBeenCalled();
  });

  it("inserts function nodes", async () => {
    await service.indexDirectory("/project");
    expect(graph.mergeNode).toHaveBeenCalledWith(
      "Function",
      expect.objectContaining({ name: "foo" }),
      expect.any(Object),
    );
  });

  it("inserts repository node", async () => {
    await service.indexDirectory("/project");
    expect(graph.mergeNode).toHaveBeenCalledWith(
      "Repository",
      expect.objectContaining({ path: expect.any(String) }),
      expect.any(Object),
    );
  });

  it("marks job as failed on error", async () => {
    (graph.ensureSchema as any).mockRejectedValue(new Error("DB down"));
    const jobId = await service.indexDirectory("/project");
    const job = jobStore.get(jobId);
    expect(job?.status).toBe("failed");
    expect(job?.error).toContain("DB down");
  });

  it("returns null for unsupported file types", async () => {
    const result = await service.indexFile("/test.py", "/project", new Map());
    expect(result).toBeNull();
  });

  it("removeFile delegates to graph.deleteFileNodes", async () => {
    await service.removeFile("/project/test.js");
    expect(graph.deleteFileNodes).toHaveBeenCalledWith("/project/test.js");
  });
});
