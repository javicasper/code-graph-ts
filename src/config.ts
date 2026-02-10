export interface AppConfig {
  neo4jUri: string;
  neo4jUsername: string;
  neo4jPassword: string;
  zaiApiKey?: string;
  zaiBaseUrl?: string;
  zaiDescriptionModel?: string;
  useLocalEmbeddings?: boolean;
}

import { homedir } from "node:os";
import { join } from "node:path";
import dotenv from "dotenv";

export function loadConfig(): AppConfig {
  // Load global config first
  const globalConfigPath = join(homedir(), ".codegraph", ".env");
  dotenv.config({ path: globalConfigPath });

  // Load local config (overrides global)
  dotenv.config();

  return {
    neo4jUri: process.env.NEO4J_URI ?? "bolt://localhost:7687",
    neo4jUsername: process.env.NEO4J_USERNAME ?? "neo4j",
    neo4jPassword: process.env.NEO4J_PASSWORD ?? "codegraph123",
    zaiApiKey: process.env.ZAI_API_KEY,
    zaiBaseUrl: process.env.ZAI_BASE_URL,
    zaiDescriptionModel: process.env.ZAI_DESCRIPTION_MODEL,
    useLocalEmbeddings: process.env.USE_LOCAL_EMBEDDINGS === "true",
  };
}
