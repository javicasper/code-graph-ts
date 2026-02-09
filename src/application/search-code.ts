import type { SearchCode, GraphReader, Logger } from "../domain/ports.js";
import type { SearchResult } from "../domain/types.js";
import { toNumber } from "../domain/neo4j-helpers.js";

export class SearchCodeService implements SearchCode {
  constructor(
    private readonly graph: GraphReader,
    private readonly logger?: Logger,
  ) {}

  async fulltextSearch(query: string, limit: number): Promise<SearchResult[]> {
    try {
      const rows = await this.graph.runQuery(
        `CALL db.index.fulltext.queryNodes("code_search", $query)
         YIELD node, score
         RETURN labels(node) as labels, node.name as name, node.path as path,
                node.line_number as line_number, score
         ORDER BY score DESC LIMIT toInteger($limit)`,
        { query, limit },
      );
      return rows.map((r) => ({
        labels: r.labels as string[],
        name: r.name as string,
        path: r.path as string,
        lineNumber: toNumber(r.line_number),
        score: r.score as number | undefined,
      }));
    } catch {
      this.logger?.warn("Fulltext index not available, falling back to CONTAINS search");
      const rows = await this.graph.runQuery(
        `MATCH (n) WHERE (n:Function OR n:Class OR n:Variable) AND n.name CONTAINS $query
         RETURN labels(n) as labels, n.name as name, n.path as path, n.line_number as line_number
         LIMIT toInteger($limit)`,
        { query, limit },
      );
      return rows.map((r) => ({
        labels: r.labels as string[],
        name: r.name as string,
        path: r.path as string,
        lineNumber: toNumber(r.line_number),
      }));
    }
  }

  async cypherQuery(
    query: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown[]> {
    // Enforce read-only
    const upper = query.trim().toUpperCase();
    if (
      upper.startsWith("CREATE") ||
      upper.startsWith("MERGE") ||
      upper.startsWith("DELETE") ||
      upper.startsWith("SET") ||
      upper.startsWith("REMOVE") ||
      upper.startsWith("DROP")
    ) {
      throw new Error("Only read-only queries are allowed.");
    }
    return this.graph.runQuery(query, params);
  }
}
