// Public API exports

// ── Domain types ────────────────────────────────────────────────
export type {
  ParsedFile,
  ParsedFunction,
  ParsedClass,
  ParsedImport,
  ParsedCall,
  ParsedVariable,
  ImportsMap,
  LanguageParser,
  IndexJob,
  GraphStats,
  SupportedLanguage,
  SearchResult,
  CallerResult,
  CalleeResult,
  DeadCodeResult,
  ImporterResult,
  ComplexityResult,
} from "./domain/types.js";

// ── Domain ports ────────────────────────────────────────────────
export type {
  FileSystem,
  GraphReader,
  GraphWriter,
  GraphRepository,
  Logger,
  JobStore,
  IndexCode,
  SearchCode,
  AnalyzeCode,
  WatchFiles,
  ManageRepositories,
} from "./domain/ports.js";

// ── Domain ──────────────────────────────────────────────────────
export { resolveSymbol } from "./domain/symbol-resolver.js";
export { JavaScriptParser } from "./domain/parsers/javascript.js";
export { TypeScriptParser } from "./domain/parsers/typescript.js";
export { PHPParser } from "./domain/parsers/php.js";

// ── Application ─────────────────────────────────────────────────
export { IndexCodeService } from "./application/index-code.js";
export { SearchCodeService } from "./application/search-code.js";
export { AnalyzeCodeService } from "./application/analyze-code.js";
export { WatchFilesService } from "./application/watch-files.js";
export { ManageRepositoriesService } from "./application/manage-repositories.js";
export { InMemoryJobStore } from "./application/job-store.js";

// ── Infrastructure ──────────────────────────────────────────────
export { Neo4jGraphRepository } from "./infrastructure/neo4j-graph-repository.js";
export { NodeFileSystem } from "./infrastructure/node-filesystem.js";
export { ConsoleLogger } from "./infrastructure/console-logger.js";

// ── Composition ─────────────────────────────────────────────────
export { loadConfig } from "./config.js";
export type { AppConfig } from "./config.js";
export { createAppServices } from "./composition-root.js";
export type { AppServices } from "./composition-root.js";

// ── Adapters ────────────────────────────────────────────────────
export { createMCPServer, startMCPServer } from "./adapters/mcp/server.js";
export { TOOL_DEFINITIONS, createToolHandler } from "./adapters/mcp/tools.js";
