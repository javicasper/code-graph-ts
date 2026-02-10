// ── Parsed entities ──────────────────────────────────────────────

export type SupportedLanguage = "javascript" | "typescript" | "php";

export interface ParsedFunction {
  name: string;
  lineNumber: number;
  endLine: number;
  args: string[];
  source?: string;
  docstring?: string;
  cyclomaticComplexity: number;
  context?: string;
  classContext?: string;
  decorators?: string[];
  isAsync?: boolean;
  kind?: "getter" | "setter" | "static" | "constructor";
}

export interface ParsedClass {
  name: string;
  lineNumber: number;
  endLine: number;
  bases: string[];
  implements?: string[];
  source?: string;
  docstring?: string;
  isAbstract?: boolean;
  isInterface?: boolean;
}

export interface ParsedImport {
  name: string;
  source: string;
  alias?: string;
  lineNumber: number;
  isDefault?: boolean;
  isNamespace?: boolean;
}

export interface ParsedCall {
  name: string;
  lineNumber: number;
  args: string[];
  callerName?: string;
  callerLineNumber?: number;
  fullCallName?: string;
  inferredObjType?: string;
}

export interface ParsedVariable {
  name: string;
  lineNumber: number;
  value?: string;
  type?: string;
  context?: string;
  classContext?: string;
}

export interface ParsedFile {
  path: string;
  repoPath: string;
  lang: string;
  source?: string; // Full source code
  functions: ParsedFunction[];
  classes: ParsedClass[];
  imports: ParsedImport[];
  calls: ParsedCall[];
  variables: ParsedVariable[];
}

// ── Cross-file symbol resolution ────────────────────────────────

export type ImportsMap = Map<string, { filePath: string; lineNumber: number }[]>;

// ── Parser interface (receives source string, not file path) ────

export interface LanguageParser {
  readonly supportedExtensions: string[];
  readonly languageName: string;
  parse(sourceCode: string, filePath: string, isDependency?: boolean): ParsedFile;
  preScan(files: { filePath: string; sourceCode: string }[]): ImportsMap;
}

// ── Indexing job ────────────────────────────────────────────────

export interface IndexJob {
  id: string;
  path: string;
  status: "running" | "completed" | "failed";
  filesTotal: number;
  filesProcessed: number;
  startedAt: Date;
  completedAt?: Date;
  error?: string;
}

// ── Graph stats ─────────────────────────────────────────────────


// ── Graph stats ─────────────────────────────────────────────────

export interface GraphStats {
  repositories: number;
  files: number;
  functions: number;
  classes: number;
  variables: number;
  relationships: number;
}

// ── Semantic Search Types ───────────────────────────────────────

export interface SymbolSummary {
  name: string;
  kind: "function" | "class" | "variable";
  path: string;
  lineNumber: number;
  description: string;
  contentHash: string; // SHA-256 of source to avoid re-generating
}

export interface SemanticSearchResult {
  name: string;
  kind: string;
  path: string;
  lineNumber?: number;
  description: string;
  score: number;
}

// ── Result types for analysis ───────────────────────────────────

export interface SearchResult {
  labels: string[];
  name: string;
  path: string;
  lineNumber?: number;
  score?: number;
}

export interface CallerResult {
  callerName: string;
  callerPath: string;
  callerLine?: number;
  callLine?: number;
}

export interface CalleeResult {
  calleeName: string;
  calleePath: string;
  calleeLine?: number;
  callLine?: number;
}

export interface DeadCodeResult {
  name: string;
  path: string;
  lineNumber?: number;
}

export interface ImporterResult {
  filePath: string;
  module: string;
  importedName: string;
}

export interface ComplexityResult {
  name: string;
  path: string;
  lineNumber?: number;
  complexity?: number;
}
