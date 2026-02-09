export interface AppConfig {
  neo4jUri: string;
  neo4jUsername: string;
  neo4jPassword: string;
}

export function loadConfig(): AppConfig {
  return {
    neo4jUri: process.env.NEO4J_URI ?? "bolt://localhost:7687",
    neo4jUsername: process.env.NEO4J_USERNAME ?? "neo4j",
    neo4jPassword: process.env.NEO4J_PASSWORD ?? "codegraph123",
  };
}
