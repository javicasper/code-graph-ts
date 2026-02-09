// Public API exports
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
} from "./core/types.js";

export { Database, getDatabase, closeDatabase } from "./core/database.js";
export { GraphBuilder, getJob, getAllJobs } from "./core/graph-builder.js";
export { FileWatcher } from "./core/watcher.js";
export { createMCPServer, startMCPServer } from "./mcp/server.js";
export { TOOL_DEFINITIONS, handleToolCall } from "./mcp/tools.js";

export { JavaScriptParser } from "./parsers/javascript.js";
export { TypeScriptParser } from "./parsers/typescript.js";
export { PHPParser } from "./parsers/php.js";
