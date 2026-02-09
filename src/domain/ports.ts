import type {
  IndexJob,
  ParsedFile,
  ImportsMap,
  GraphStats,
  SearchResult,
  CallerResult,
  CalleeResult,
  DeadCodeResult,
  ImporterResult,
  ComplexityResult,
} from "./types.js";

// ── Outbound ports ──────────────────────────────────────────────

export interface GlobOptions {
  cwd: string;
  absolute?: boolean;
  ignore?: string[];
}

export interface FileSystem {
  readFile(filePath: string): string;
  exists(filePath: string): boolean;
  glob(patterns: string[], options: GlobOptions): Promise<string[]>;
}

export type QueryResultRow = Record<string, unknown>;
export type QueryResultRows = QueryResultRow[];

export interface GraphReader {
  runQuery(cypher: string, params?: Record<string, unknown>): Promise<QueryResultRows>;
}

export interface GraphWriter {
  ensureSchema(): Promise<void>;
  mergeNode(label: string, key: Record<string, unknown>, props?: Record<string, unknown>): Promise<void>;
  mergeRelationship(
    fromLabel: string,
    fromKey: Record<string, unknown>,
    toLabel: string,
    toKey: Record<string, unknown>,
    relType: string,
    props?: Record<string, unknown>,
  ): Promise<void>;
  deleteFileNodes(filePath: string): Promise<void>;
  deleteRepository(repoPath: string): Promise<void>;
  deleteAll(): Promise<void>;
}

export interface GraphRepository extends GraphReader, GraphWriter {
  verifyConnectivity(): Promise<void>;
  close(): Promise<void>;
}

export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
}

export interface JobStore {
  create(job: IndexJob): void;
  get(id: string): IndexJob | undefined;
  getAll(): IndexJob[];
  update(id: string, partial: Partial<IndexJob>): void;
}

// ── Inbound ports (use cases) ───────────────────────────────────

export interface IndexCode {
  indexDirectory(dirPath: string, isDependency?: boolean): Promise<string>;
  indexFile(
    filePath: string,
    repoPath: string,
    importsMap: ImportsMap,
    isDependency?: boolean,
  ): Promise<ParsedFile | null>;
  removeFile(filePath: string): Promise<void>;
  collectFiles(dirPath: string): Promise<string[]>;
}

export interface SearchCode {
  fulltextSearch(query: string, limit: number): Promise<SearchResult[]>;
  cypherQuery(query: string, params?: Record<string, unknown>): Promise<unknown[]>;
}

export interface AnalyzeCode {
  findCallers(name: string, limit: number): Promise<CallerResult[]>;
  findCallees(name: string, limit: number): Promise<CalleeResult[]>;
  classHierarchy(name: string, depth: number): Promise<string[][]>;
  deadCode(limit: number, repoPath?: string): Promise<DeadCodeResult[]>;
  callChain(name: string, depth: number, limit: number): Promise<string[][]>;
  findImporters(name: string, limit: number): Promise<ImporterResult[]>;
  moduleDeps(name: string, limit: number): Promise<string[]>;
  findComplexity(name: string, limit: number): Promise<ComplexityResult[]>;
  mostComplexFunctions(limit: number, repoPath?: string): Promise<ComplexityResult[]>;
  calculateComplexity(name: string, path?: string): Promise<ComplexityResult[]>;
}

export interface WatchFiles {
  watch(dirPath: string): Promise<void>;
  unwatch(dirPath: string): Promise<void>;
  getWatchedPaths(): string[];
  closeAll(): Promise<void>;
}

export interface ManageRepositories {
  listRepositories(): Promise<{ path: string; name: string }[]>;
  deleteRepository(repoPath: string): Promise<void>;
  deleteAll(): Promise<void>;
  getStats(repoPath?: string): Promise<GraphStats>;
}
