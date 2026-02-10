import type { ManageRepositories, GraphRepository } from "../domain/ports.js";
import type { GraphStats } from "../domain/types.js";
import { toCount } from "../domain/neo4j-helpers.js";

export class ManageRepositoriesService implements ManageRepositories {
  constructor(private readonly graph: GraphRepository) { }

  async listRepositories(): Promise<{ path: string; name: string }[]> {
    const rows = await this.graph.runQuery(
      "MATCH (r:Repository) RETURN r.path as path, r.name as name",
    );
    return rows.map((r) => ({
      path: r.path as string,
      name: r.name as string,
    }));
  }

  async deleteRepository(repoPath: string): Promise<void> {
    await this.graph.deleteRepository(repoPath);
  }

  async deleteAll(): Promise<void> {
    await this.graph.deleteAll();
  }

  async getStats(repoPath?: string): Promise<GraphStats> {
    const where = repoPath ? "WHERE n.repo_path = $repoPath" : "";
    const params = repoPath ? { repoPath } : {};

    const [repos, files, functions, classes, variables, rels] = await Promise.all([
      this.graph.runQuery(
        `MATCH (n:Repository) ${repoPath ? "WHERE n.path = $repoPath" : ""} RETURN count(n) as c`,
        params,
      ),
      this.graph.runQuery(
        `MATCH (n:File) ${where} RETURN count(n) as c`,
        params,
      ),
      this.graph.runQuery(`MATCH (n:Function) ${where} RETURN count(n) as c`, params),
      this.graph.runQuery(`MATCH (n:Class) ${where} RETURN count(n) as c`, params),
      this.graph.runQuery(`MATCH (n:Variable) ${where} RETURN count(n) as c`, params),
      this.graph.runQuery(
        `MATCH (n) ${repoPath ? "WHERE n.repo_path = $repoPath" : ""} MATCH (n)-[r]->() RETURN count(r) as c`,
        params
      ),
    ]);

    return {
      repositories: toCount(repos),
      files: toCount(files),
      functions: toCount(functions),
      classes: toCount(classes),
      variables: toCount(variables),
      relationships: toCount(rels),
    };
  }
}
