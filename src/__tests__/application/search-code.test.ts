import { describe, it, expect, vi, beforeEach } from "vitest";
import { SearchCodeService } from "../../application/search-code.js";
import type { GraphReader, Logger } from "../../domain/ports.js";

describe("SearchCodeService", () => {
  let mockGraph: GraphReader;
  let mockLogger: Logger;

  beforeEach(() => {
    mockGraph = {
      runQuery: vi.fn(),
      vectorSearch: vi.fn(),
      getContentHash: vi.fn(),
    };
    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };
  });

  describe("fulltextSearch", () => {
    it("should use fulltext index when available", async () => {
      (mockGraph.runQuery as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { labels: ["Function"], name: "greet", path: "/a.ts", line_number: 5, score: 1.5 },
      ]);

      const service = new SearchCodeService(mockGraph, mockLogger);
      const results = await service.fulltextSearch("greet", 10);

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("greet");
      expect(results[0].score).toBe(1.5);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it("should fall back to CONTAINS when fulltext index fails", async () => {
      (mockGraph.runQuery as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error("No fulltext index"))
        .mockResolvedValueOnce([
          { labels: ["Class"], name: "Greeter", path: "/b.ts", line_number: 10 },
        ]);

      const service = new SearchCodeService(mockGraph, mockLogger);
      const results = await service.fulltextSearch("Greet", 10);

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("Greeter");
      expect(results[0].score).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Fulltext index not available"),
      );
    });
  });

  describe("cypherQuery", () => {
    it("should execute read-only queries", async () => {
      (mockGraph.runQuery as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ count: 42 }]);

      const service = new SearchCodeService(mockGraph);
      const result = await service.cypherQuery("MATCH (n) RETURN count(n) as count");

      expect(result).toEqual([{ count: 42 }]);
    });

    it.each(["CREATE", "MERGE", "DELETE", "SET", "REMOVE", "DROP"])(
      "should reject %s queries",
      async (keyword) => {
        const service = new SearchCodeService(mockGraph);
        await expect(
          service.cypherQuery(`${keyword} (n:Test)`),
        ).rejects.toThrow("Only read-only queries are allowed.");
      },
    );

    it("should pass params to graph", async () => {
      (mockGraph.runQuery as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      const service = new SearchCodeService(mockGraph);
      await service.cypherQuery("MATCH (n) WHERE n.name = $name RETURN n", { name: "foo" });

      expect(mockGraph.runQuery).toHaveBeenCalledWith(
        "MATCH (n) WHERE n.name = $name RETURN n",
        { name: "foo" },
      );
    });
  });
});
