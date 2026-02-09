import neo4j, { type Driver, type Session, type ManagedTransaction } from "neo4j-driver";
import type { GraphRepository, QueryResultRows } from "../domain/ports.js";

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

// ── Repository implementation ───────────────────────────────────

export class Neo4jGraphRepository implements GraphRepository {
  private driver: Driver;
  private batchTx: ManagedTransaction | null = null;

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
  }

  async executeBatch(fn: () => Promise<void>): Promise<void> {
    const session = this.driver.session();
    try {
      await session.executeWrite(async (tx) => {
        this.batchTx = tx;
        try {
          await fn();
        } finally {
          this.batchTx = null;
        }
      });
    } finally {
      await session.close();
    }
  }

  async runQuery(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<QueryResultRows> {
    if (this.batchTx) {
      const result = await this.batchTx.run(cypher, params);
      return result.records.map((r) => r.toObject());
    }
    const session = this.driver.session();
    try {
      const result = await session.run(cypher, params);
      return result.records.map((r) => r.toObject());
    } finally {
      await session.close();
    }
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
    if (this.batchTx) {
      await this.batchTx.run(cypher, params);
      return;
    }
    const session = this.driver.session();
    try {
      await session.run(cypher, params);
    } finally {
      await session.close();
    }
  }
}
