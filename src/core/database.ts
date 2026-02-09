import neo4j, {
  type Driver,
  type Session,
  type ManagedTransaction,
  type QueryResult,
} from "neo4j-driver";

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

// ── Database wrapper ────────────────────────────────────────────

export class Database {
  private driver: Driver;

  constructor(uri: string, username: string, password: string) {
    this.driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
  }

  /** Verify the connection is alive. */
  async verifyConnectivity(): Promise<void> {
    await this.driver.verifyConnectivity();
  }

  /** Create constraints, indexes, and fulltext indexes. */
  async ensureSchema(): Promise<void> {
    for (const stmt of SCHEMA_STATEMENTS) {
      await this.runQuery(stmt);
    }
    try {
      await this.runQuery(FULLTEXT_INDEX);
    } catch {
      // fulltext index may already exist or syntax may differ across versions
    }
  }

  /** Execute a single Cypher query. */
  async runQuery(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<QueryResult> {
    const session = this.driver.session();
    try {
      return await session.run(cypher, params);
    } finally {
      await session.close();
    }
  }

  /** Execute a function inside a write-transaction. */
  async runInTransaction<T>(
    fn: (tx: ManagedTransaction) => Promise<T>,
  ): Promise<T> {
    const session = this.driver.session();
    try {
      return await session.executeWrite(fn);
    } finally {
      await session.close();
    }
  }

  /** MERGE a node by label + key properties, setting extra props. */
  async mergeNode(
    label: string,
    key: Record<string, unknown>,
    props: Record<string, unknown> = {},
  ): Promise<void> {
    const keyEntries = Object.keys(key);
    const keyClause = keyEntries.map((k) => `${k}: $key_${k}`).join(", ");
    const setEntries = Object.keys(props);
    const setClause =
      setEntries.length > 0
        ? "SET " + setEntries.map((k) => `n.${k} = $prop_${k}`).join(", ")
        : "";

    const params: Record<string, unknown> = {};
    for (const k of keyEntries) params[`key_${k}`] = key[k];
    for (const k of setEntries) params[`prop_${k}`] = props[k];

    await this.runQuery(
      `MERGE (n:${label} {${keyClause}}) ${setClause}`,
      params,
    );
  }

  /** MERGE a relationship between two nodes. */
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
    const propEntries = Object.keys(props);
    const propClause =
      propEntries.length > 0
        ? " {" + propEntries.map((k) => `${k}: $rel_${k}`).join(", ") + "}"
        : "";

    const params: Record<string, unknown> = {};
    for (const k of fromEntries) params[`from_${k}`] = fromKey[k];
    for (const k of toEntries) params[`to_${k}`] = toKey[k];
    for (const k of propEntries) params[`rel_${k}`] = props[k];

    await this.runQuery(
      `MATCH (a:${fromLabel} {${fromClause}}), (b:${toLabel} {${toClause}})
       MERGE (a)-[:${relType}${propClause}]->(b)`,
      params,
    );
  }

  /** Delete all nodes and relationships originating from a file. */
  async deleteFileNodes(filePath: string): Promise<void> {
    await this.runQuery(
      `MATCH (f:File {path: $path})-[:CONTAINS]->(n) DETACH DELETE n`,
      { path: filePath },
    );
    await this.runQuery(
      `MATCH (f:File {path: $path}) DETACH DELETE f`,
      { path: filePath },
    );
  }

  /** Delete all nodes belonging to a repository. */
  async deleteRepository(repoPath: string): Promise<void> {
    await this.runQuery(
      `MATCH (r:Repository {path: $path})-[*]->(n) DETACH DELETE n, r`,
      { path: repoPath },
    );
  }

  /** Close the driver. */
  async close(): Promise<void> {
    await this.driver.close();
  }
}

// ── Singleton helper ────────────────────────────────────────────

let _instance: Database | null = null;

export function getDatabase(): Database {
  if (!_instance) {
    const uri = process.env.NEO4J_URI ?? "bolt://localhost:7687";
    const user = process.env.NEO4J_USERNAME ?? "neo4j";
    const pass = process.env.NEO4J_PASSWORD ?? "codegraph123";
    _instance = new Database(uri, user, pass);
  }
  return _instance;
}

export async function closeDatabase(): Promise<void> {
  if (_instance) {
    await _instance.close();
    _instance = null;
  }
}
