import { watch, type FSWatcher } from "chokidar";
import { resolve, extname } from "node:path";
import type { IndexCode, DescribeCode } from "../domain/ports.js";
import type { Logger } from "../domain/logger.js";
import type { ImportsMap } from "../domain/types.js";

const SUPPORTED_EXTENSIONS = new Set([
  ".js", ".jsx", ".mjs", ".cjs",
  ".ts", ".tsx",
  ".php",
]);

const DEBOUNCE_MS = 2000;

export class WatchFilesService {
  private watchers = new Map<string, FSWatcher>();
  private importsMapCache = new Map<string, ImportsMap>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly indexCode: IndexCode,
    private readonly describeCode: DescribeCode,
    private readonly logger: Logger,
  ) { }

  async watch(dirPath: string): Promise<void> {
    const absPath = resolve(dirPath);
    if (this.watchers.has(absPath)) return;

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
    this.logger.info(`Watching: ${absPath}`);
  }

  async unwatch(dirPath: string): Promise<void> {
    const absPath = resolve(dirPath);
    const watcher = this.watchers.get(absPath);
    if (watcher) {
      await watcher.close();
      this.watchers.delete(absPath);
      this.importsMapCache.delete(absPath);
      this.logger.info(`Unwatched: ${absPath}`);
    }
  }

  getWatchedPaths(): string[] {
    return Array.from(this.watchers.keys());
  }

  async closeAll(): Promise<void> {
    for (const [, watcher] of this.watchers) {
      await watcher.close();
    }
    this.watchers.clear();
    this.importsMapCache.clear();
  }

  // ── Event handlers ──────────────────────────────────────────

  private handleChange(repoPath: string, filePath: string): void {
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
          this.logger.info(`Re-indexing: ${filePath}`);
          const importsMap = this.importsMapCache.get(repoPath) ?? new Map();

          // 1. Index structure & Describe (now handled inside indexFile)
          await this.indexCode.indexFile(filePath, repoPath, importsMap);

          this.logger.info(`Re-indexed and described: ${filePath}`);
        } catch (err) {
          this.logger.error(`Error re-indexing ${filePath}:`, err);
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
          this.logger.info(`Removing from graph: ${filePath}`);
          await this.indexCode.removeFile(filePath);
          this.logger.info(`Removed: ${filePath}`);
        } catch (err) {
          this.logger.error(`Error removing ${filePath}:`, err);
        }
      }, DEBOUNCE_MS),
    );
  }
}
