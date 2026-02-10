import { AsyncLocalStorage } from "node:async_hooks";
import neo4j, { type Driver, type Session, type ManagedTransaction } from "neo4j-driver";
import type { GraphRepository, QueryResultRows } from "../domain/ports.js";
import type { SemanticSearchResult } from "../domain/types.js";

// ── Schema DDL ──────────────────────────────────────────────────

const SCHEMA_STATEMENTS = [
  "CREATE CONSTRAINT repo_path IF NOT EXISTS FOR (r:Repository) REQUIRE r.path IS UNIQUE",
  "CREATE CONSTRAINT file_path IF NOT EXISTS FOR (f:File) REQUIRE f.path IS UNIQUE",
  "CREATE CONSTRAINT dir_path IF NOT EXISTS FOR (d:Directory) REQUIRE d.path IS UNIQUE",
  "CREATE CONSTRAINT module_name IF NOT EXISTS FOR (m:Module) REQUIRE m.name IS UNIQUE",
  "CREATE CONSTRAINT func_unique IF NOT EXISTS FOR (f:Function) REQUIRE (f.name, f.path, f.line_number) IS UNIQUE",
  "CREATE CONSTRAINT class_unique IF NOT EXISTS FOR (c:Class) REQUIRE (c.name, c.path, c.line_number) IS UNIQUE",
  "CREATE CONSTRAINT var_unique IF NOT EXISTS FOR (v:Variable) REQUIRE (v.name, v.path, v.line_number) IS UNIQUE",
  "CREATE INDEX func_lang IF NOT EXISTS FOR (f:Function) ON (f.lang)",
  "CREATE INDEX class_lang IF NOT EXISTS FOR (c:Class) ON (c.lang)",
];

const FULLTEXT_INDEX = `
  CREATE FULLTEXT INDEX code_search IF NOT EXISTS
  FOR (n:Function|Class|Variable) ON EACH [n.name]
`;

const VECTOR_INDEXES = [
  `CREATE VECTOR INDEX function_embeddings IF NOT EXISTS FOR (n:Function) ON (n.embedding)
   OPTIONS {indexConfig: { \`vector.dimensions\`: 384, \`vector.similarity_function\`: 'cosine' }}`,
  `CREATE VECTOR INDEX class_embeddings IF NOT EXISTS FOR (n:Class) ON (n.embedding)
   OPTIONS {indexConfig: { \`vector.dimensions\`: 384, \`vector.similarity_function\`: 'cosine' }}`,
  `CREATE VECTOR INDEX variable_embeddings IF NOT EXISTS FOR (n:Variable) ON (n.embedding)
   OPTIONS {indexConfig: { \`vector.dimensions\`: 384, \`vector.similarity_function\`: 'cosine' }}`,
  `CREATE VECTOR INDEX file_embeddings IF NOT EXISTS FOR (n:File) ON (n.embedding)
   OPTIONS {indexConfig: { \`vector.dimensions\`: 384, \`vector.similarity_function\`: 'cosine' }}`,
  `CREATE VECTOR INDEX directory_embeddings IF NOT EXISTS FOR (n:Directory) ON (n.embedding)
   OPTIONS {indexConfig: { \`vector.dimensions\`: 384, \`vector.similarity_function\`: 'cosine' }}`
];

// ── Repository implementation ───────────────────────────────────

export class Neo4jGraphRepository implements GraphRepository {
  private readonly driver: Driver;
  private readonly storage = new AsyncLocalStorage<ManagedTransaction>();

  constructor(uri: string, username: string, password: string) {
    this.driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
  }

  async verifyConnectivity(): Promise<void> {
    await this.driver.verifyConnectivity();
  }

  async ensureSchema(): Promise<void> {
    for (const stmt of SCHEMA_STATEMENTS) {
      await this.runWriteQuery(stmt);
    }
    try {
      await this.runWriteQuery(FULLTEXT_INDEX);
    } catch {
      // fulltext index may already exist or syntax may differ across versions
    }
    await this.ensureVectorIndex();
  }

  async executeBatch(fn: () => Promise<void>): Promise<void> {
    const session = this.driver.session();
    try {
      await session.executeWrite(async (tx) => {
        await this.storage.run(tx, async () => {
          await fn();
        });
      });
    } finally {
      await session.close();
    }
  }

  async runQuery(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<QueryResultRows> {
    const tx = this.storage.getStore();
    if (tx) {
      const result = await tx.run(cypher, params);
      return result.records.map((r: any) => r.toObject());
    }
    const session = this.driver.session();
    try {
      const result = await session.run(cypher, params);
      return result.records.map((r) => r.toObject());
    } finally {
      await session.close();
    }
  }

  async vectorSearch(embedding: number[], limit: number): Promise<SemanticSearchResult[]> {
    // Note: Neo4j vector search requires specific handling of limits and scores.
    // We search all 3 indexes and combine results.
    const cypher = `
      CALL {
        CALL db.index.vector.queryNodes('function_embeddings', $limit, $embedding) YIELD node, score RETURN node, score
        UNION
        CALL db.index.vector.queryNodes('class_embeddings', $limit, $embedding) YIELD node, score RETURN node, score
        UNION
        CALL db.index.vector.queryNodes('variable_embeddings', $limit, $embedding) YIELD node, score RETURN node, score
        UNION
        CALL db.index.vector.queryNodes('file_embeddings', $limit, $embedding) YIELD node, score RETURN node, score
        UNION
        CALL db.index.vector.queryNodes('directory_embeddings', $limit, $embedding) YIELD node, score RETURN node, score
      }
      RETURN node.name as name, labels(node) as labels, node.path as path,
             node.line_number as line_number, node.description as description, 
             node.repo_path as repo_path, score
      ORDER BY score DESC
      LIMIT $limit
    `;

    const rows = await this.runQuery(cypher, { embedding, limit: neo4j.int(limit) });

    return rows.map(row => ({
      name: (row.name as string) || (row.path as string)?.split('/').pop() || (row.path as string) || "unknown",
      kind: (row.labels as string[]).find(l => ["Function", "Class", "Variable", "File", "Directory"].includes(l))?.toLowerCase() ?? "unknown",
      path: row.path as string,
      lineNumber: (row.line_number && typeof row.line_number === 'object') ? (row.line_number as any).low : row.line_number as number,
      description: row.description as string,
      repoPath: row.repo_path as string,
      score: row.score as number
    }));
  }

  async getContentHash(label: string, key: Record<string, unknown>): Promise<string | null> {
    const keyEntries = Object.keys(key);
    const keyClause = keyEntries.map((k) => `${k}: $key_${k}`).join(", ");

    const params: Record<string, unknown> = {};
    for (const k of keyEntries) params[`key_${k}`] = key[k];

    const rows = await this.runQuery(
      `MATCH (n:${label} {${keyClause}}) RETURN n.content_hash as hash`,
      params
    );

    return rows.length > 0 ? (rows[0].hash as string) : null;
  }

  async mergeNode(
    label: string,
    key: Record<string, unknown>,
    props: Record<string, unknown> = {},
  ): Promise<void> {
    const keyEntries = Object.keys(key);
    const keyClause = keyEntries.map((k) => `${k}: $key_${k}`).join(", ");
    const setEntries = Object.keys(props).filter((k) => props[k] !== undefined);
    const setClause =
      setEntries.length > 0
        ? "SET " + setEntries.map((k) => `n.${k} = $prop_${k}`).join(", ")
        : "";

    const params: Record<string, unknown> = {};
    for (const k of keyEntries) params[`key_${k}`] = key[k];
    for (const k of setEntries) params[`prop_${k}`] = props[k];

    await this.runWriteQuery(
      `MERGE (n:${label} {${keyClause}}) ${setClause}`,
      params,
    );
  }

  async mergeRelationship(
    fromLabel: string,
    fromKey: Record<string, unknown>,
    toLabel: string,
    toKey: Record<string, unknown>,
    relType: string,
    props: Record<string, unknown> = {},
  ): Promise<void> {
    const fromEntries = Object.keys(fromKey);
    const toEntries = Object.keys(toKey);
    const fromClause = fromEntries
      .map((k) => `${k}: $from_${k}`)
      .join(", ");
    const toClause = toEntries.map((k) => `${k}: $to_${k}`).join(", ");
    const propEntries = Object.keys(props).filter((k) => props[k] !== undefined);
    const propClause =
      propEntries.length > 0
        ? " {" + propEntries.map((k) => `${k}: $rel_${k}`).join(", ") + "}"
        : "";

    const params: Record<string, unknown> = {};
    for (const k of fromEntries) params[`from_${k}`] = fromKey[k];
    for (const k of toEntries) params[`to_${k}`] = toKey[k];
    for (const k of propEntries) params[`rel_${k}`] = props[k];

    await this.runWriteQuery(
      `MATCH (a:${fromLabel} {${fromClause}}), (b:${toLabel} {${toClause}})
       MERGE (a)-[:${relType}${propClause}]->(b)`,
      params,
    );
  }

  async deleteFileNodes(filePath: string): Promise<void> {
    await this.runWriteQuery(
      `MATCH (f:File {path: $path})-[:CONTAINS]->(n) DETACH DELETE n`,
      { path: filePath },
    );
    await this.runWriteQuery(
      `MATCH (f:File {path: $path}) DETACH DELETE f`,
      { path: filePath },
    );
  }

  async deleteRepository(repoPath: string): Promise<void> {
    await this.runWriteQuery(
      `MATCH (r:Repository {path: $path})-[*]->(n) DETACH DELETE n, r`,
      { path: repoPath },
    );
  }

  async deleteAll(): Promise<void> {
    await this.runWriteQuery("MATCH (n) DETACH DELETE n");
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  // ── Private helper ────────────────────────────────────────────

  private async runWriteQuery(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<void> {
    const tx = this.storage.getStore();
    if (tx) {
      await tx.run(cypher, params);
      return;
    }
    const session = this.driver.session();
    try {
      await session.run(cypher, params);
    } finally {
      await session.close();
    }
  }

  async ensureVectorIndex(): Promise<void> {
    try {
      for (const stmt of VECTOR_INDEXES) {
        await this.runWriteQuery(stmt);
      }
    } catch (error) {
      console.warn("Ensure vector index warning:", error);
    }
  }

  async setNodeEmbedding(
    label: string,
    key: Record<string, unknown>,
    embedding: number[],
    description: string,
    contentHash: string,
  ): Promise<void> {
    const keyEntries = Object.keys(key);
    const keyClause = keyEntries.map((k) => `${k}: $key_${k}`).join(", ");

    const params: Record<string, unknown> = {
      embedding,
      description,
      contentHash,
    };
    for (const k of keyEntries) params[`key_${k}`] = key[k];

    await this.runWriteQuery(
      `MATCH (n:${label} {${keyClause}})
       SET n.embedding = $embedding,
           n.description = $description,
           n.content_hash = $contentHash`,
      params
    );
  }
}
