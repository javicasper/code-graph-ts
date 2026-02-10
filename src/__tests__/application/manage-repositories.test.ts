import { describe, it, expect, vi, beforeEach } from "vitest";
import { ManageRepositoriesService } from "../../application/manage-repositories.js";
import type { GraphRepository } from "../../domain/ports.js";

function mockGraphRepository(): GraphRepository {
  return {
    runQuery: vi.fn(),
    ensureSchema: vi.fn(),
    mergeNode: vi.fn(),
    mergeRelationship: vi.fn(),
    deleteFileNodes: vi.fn(),
    deleteRepository: vi.fn(),
    deleteAll: vi.fn(),
    verifyConnectivity: vi.fn(),
    close: vi.fn(),
    executeBatch: vi.fn(async (fn: () => Promise<void>) => fn()),
    ensureVectorIndex: vi.fn(),
    setNodeEmbedding: vi.fn(),
    vectorSearch: vi.fn(),
    getContentHash: vi.fn(),
  };
}

describe("ManageRepositoriesService", () => {
  let mockGraph: GraphRepository;
  let service: ManageRepositoriesService;

  beforeEach(() => {
    mockGraph = mockGraphRepository();
    service = new ManageRepositoriesService(mockGraph);
  });

  it("should list repositories", async () => {
    (mockGraph.runQuery as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { path: "/project-a", name: "project-a" },
      { path: "/project-b", name: "project-b" },
    ]);

    const repos = await service.listRepositories();
    expect(repos).toHaveLength(2);
    expect(repos[0]).toEqual({ path: "/project-a", name: "project-a" });
  });

  it("should delete a repository", async () => {
    await service.deleteRepository("/project-a");
    expect(mockGraph.deleteRepository).toHaveBeenCalledWith("/project-a");
  });

  it("should delete all repositories", async () => {
    await service.deleteAll();
    expect(mockGraph.deleteAll).toHaveBeenCalled();
  });

  it("should get stats", async () => {
    const countResult = [{ c: 5 }];
    (mockGraph.runQuery as ReturnType<typeof vi.fn>).mockResolvedValue(countResult);

    const stats = await service.getStats();
    expect(stats).toEqual({
      repositories: 5,
      files: 5,
      functions: 5,
      classes: 5,
      variables: 5,
      relationships: 5,
    });
    // 6 queries: repos, files, functions, classes, variables, relationships
    expect(mockGraph.runQuery).toHaveBeenCalledTimes(6);
  });

  it("should filter stats by repoPath", async () => {
    const countResult = [{ c: 3 }];
    (mockGraph.runQuery as ReturnType<typeof vi.fn>).mockResolvedValue(countResult);

    const stats = await service.getStats("/my-repo");
    expect(stats.repositories).toBe(3);
    // Check that queries contain WHERE clauses
    const calls = (mockGraph.runQuery as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((c: unknown[]) => (c[0] as string).includes("WHERE"))).toBe(true);
  });
});
