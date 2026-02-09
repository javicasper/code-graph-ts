import { watch, type FSWatcher } from "chokidar";
import { resolve, extname } from "node:path";
import type { GraphBuilder } from "./graph-builder.js";
import type { ImportsMap, ParsedFile } from "./types.js";

const SUPPORTED_EXTENSIONS = new Set([
  ".js", ".jsx", ".mjs", ".cjs",
  ".ts", ".tsx",
  ".php",
]);

const DEBOUNCE_MS = 2000;

export class FileWatcher {
  private builder: GraphBuilder;
  private watchers = new Map<string, FSWatcher>();
  private importsMapCache = new Map<string, ImportsMap>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  constructor(builder: GraphBuilder) {
    this.builder = builder;
  }

  /** Start watching a directory. */
  async watch(dirPath: string): Promise<void> {
    const absPath = resolve(dirPath);
    if (this.watchers.has(absPath)) return;

    // Build initial importsMap
    const files = await this.builder.collectFiles(absPath);
    // We'll re-index first so the cache is fresh
    const importsMap: ImportsMap = new Map();
    this.importsMapCache.set(absPath, importsMap);

    const watcher = watch(absPath, {
      ignored: [
        "**/node_modules/**",
        "**/vendor/**",
        "**/dist/**",
        "**/.git/**",
        "**/build/**",
      ],
      ignoreInitial: true,
      persistent: true,
    });

    watcher.on("add", (filePath) => this.handleChange(absPath, filePath));
    watcher.on("change", (filePath) => this.handleChange(absPath, filePath));
    watcher.on("unlink", (filePath) => this.handleUnlink(absPath, filePath));

    this.watchers.set(absPath, watcher);
    console.error(`Watching: ${absPath}`);
  }

  /** Stop watching a directory. */
  async unwatch(dirPath: string): Promise<void> {
    const absPath = resolve(dirPath);
    const watcher = this.watchers.get(absPath);
    if (watcher) {
      await watcher.close();
      this.watchers.delete(absPath);
      this.importsMapCache.delete(absPath);
      console.error(`Unwatched: ${absPath}`);
    }
  }

  /** List all watched paths. */
  getWatchedPaths(): string[] {
    return Array.from(this.watchers.keys());
  }

  /** Close all watchers. */
  async closeAll(): Promise<void> {
    for (const [path, watcher] of this.watchers) {
      await watcher.close();
    }
    this.watchers.clear();
    this.importsMapCache.clear();
  }

  // ── Event handlers ──────────────────────────────────────────

  private handleChange(repoPath: string, filePath: string): void {
    const ext = extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) return;

    // Debounce
    const key = filePath;
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      key,
      setTimeout(async () => {
        this.debounceTimers.delete(key);
        try {
          console.error(`Re-indexing: ${filePath}`);
          const importsMap = this.importsMapCache.get(repoPath) ?? new Map();
          await this.builder.indexFile(filePath, repoPath, importsMap);
          console.error(`Re-indexed: ${filePath}`);
        } catch (err) {
          console.error(`Error re-indexing ${filePath}:`, err);
        }
      }, DEBOUNCE_MS),
    );
  }

  private handleUnlink(repoPath: string, filePath: string): void {
    const ext = extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) return;

    const key = filePath;
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      key,
      setTimeout(async () => {
        this.debounceTimers.delete(key);
        try {
          console.error(`Removing from graph: ${filePath}`);
          await this.builder.removeFile(filePath);
          console.error(`Removed: ${filePath}`);
        } catch (err) {
          console.error(`Error removing ${filePath}:`, err);
        }
      }, DEBOUNCE_MS),
    );
  }
}
