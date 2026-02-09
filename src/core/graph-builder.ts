import { resolve, dirname, basename, relative, extname } from "node:path";
import { globby } from "globby";
import ignore from "ignore";
import { readFileSync, existsSync } from "node:fs";
import { Database, getDatabase } from "./database.js";
import type {
  LanguageParser,
  ParsedFile,
  ImportsMap,
  IndexJob,
  GraphStats,
} from "./types.js";
import { JavaScriptParser } from "../parsers/javascript.js";
import { TypeScriptParser } from "../parsers/typescript.js";
import { PHPParser } from "../parsers/php.js";

// ── Parser registry ─────────────────────────────────────────────

function createParsers(): LanguageParser[] {
  return [
    new JavaScriptParser(),
    new TypeScriptParser("typescript"),
    new PHPParser(),
  ];
}

function getParserForFile(
  parsers: LanguageParser[],
  filePath: string,
): LanguageParser | undefined {
  const ext = extname(filePath).toLowerCase();
  return parsers.find((p) => p.supportedExtensions.includes(ext));
}

// ── Job tracking ────────────────────────────────────────────────

const jobs = new Map<string, IndexJob>();

export function getJob(id: string): IndexJob | undefined {
  return jobs.get(id);
}

export function getAllJobs(): IndexJob[] {
  return Array.from(jobs.values());
}

// ── Graph Builder ───────────────────────────────────────────────

export class GraphBuilder {
  private db: Database;
  private parsers: LanguageParser[];

  constructor(db?: Database) {
    this.db = db ?? getDatabase();
    this.parsers = createParsers();
  }

  /**
   * Index a directory: pre-scan → parse & insert → link relationships.
   * Returns a job ID for status tracking.
   */
  async indexDirectory(
    dirPath: string,
    isDependency = false,
  ): Promise<string> {
    const absPath = resolve(dirPath);
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job: IndexJob = {
      id: jobId,
      path: absPath,
      status: "running",
      filesTotal: 0,
      filesProcessed: 0,
      startedAt: new Date(),
    };
    jobs.set(jobId, job);

    try {
      await this.db.ensureSchema();

      // Collect files
      const files = await this.collectFiles(absPath);
      job.filesTotal = files.length;

      if (files.length === 0) {
        job.status = "completed";
        job.completedAt = new Date();
        return jobId;
      }

      // Phase 1: Pre-scan all files to build ImportsMap
      const importsMap = this.preScanAll(files);

      // Phase 2: Parse & insert nodes
      const allParsedFiles: ParsedFile[] = [];
      for (const filePath of files) {
        try {
          const parsed = await this.indexFile(filePath, absPath, importsMap, isDependency);
          if (parsed) allParsedFiles.push(parsed);
        } catch (err) {
          console.error(`Error parsing ${filePath}:`, err);
        }
        job.filesProcessed++;
      }

      // Phase 3: Link relationships (calls, inheritance)
      for (const parsed of allParsedFiles) {
        try {
          await this.createInheritanceLinks(parsed, importsMap);
          await this.createCallLinks(parsed, importsMap, allParsedFiles);
        } catch (err) {
          console.error(`Error linking ${parsed.path}:`, err);
        }
      }

      job.status = "completed";
      job.completedAt = new Date();
    } catch (err) {
      job.status = "failed";
      job.error = String(err);
      job.completedAt = new Date();
    }

    return jobId;
  }

  /**
   * Index a single file, inserting nodes into the graph.
   */
  async indexFile(
    filePath: string,
    repoPath: string,
    importsMap: ImportsMap,
    isDependency = false,
  ): Promise<ParsedFile | null> {
    const parser = getParserForFile(this.parsers, filePath);
    if (!parser) return null;

    const parsed = parser.parse(filePath, isDependency);
    parsed.repoPath = repoPath;

    // Remove existing file nodes (for re-indexing)
    await this.db.deleteFileNodes(filePath);

    // Insert repository node
    await this.db.mergeNode("Repository", { path: repoPath }, {
      name: basename(repoPath),
    });

    // Insert directory hierarchy
    const relPath = relative(repoPath, filePath);
    const dirParts = dirname(relPath).split("/").filter(Boolean);
    let currentDir = repoPath;
    for (const part of dirParts) {
      const parentDir = currentDir;
      currentDir = resolve(currentDir, part);
      await this.db.mergeNode("Directory", { path: currentDir }, {
        name: part,
      });
      if (parentDir === repoPath) {
        await this.db.mergeRelationship(
          "Repository", { path: repoPath },
          "Directory", { path: currentDir },
          "CONTAINS_DIR",
        );
      } else {
        await this.db.mergeRelationship(
          "Directory", { path: parentDir },
          "Directory", { path: currentDir },
          "CONTAINS_DIR",
        );
      }
    }

    // Insert file node
    await this.db.mergeNode("File", { path: filePath }, {
      name: basename(filePath),
      lang: parsed.lang,
      repo_path: repoPath,
    });

    // File → Directory or Repository
    if (dirParts.length > 0) {
      await this.db.mergeRelationship(
        "Directory", { path: currentDir },
        "File", { path: filePath },
        "CONTAINS_FILE",
      );
    } else {
      await this.db.mergeRelationship(
        "Repository", { path: repoPath },
        "File", { path: filePath },
        "CONTAINS_FILE",
      );
    }

    // Insert functions
    for (const fn of parsed.functions) {
      await this.db.mergeNode(
        "Function",
        { name: fn.name, path: filePath, line_number: fn.lineNumber },
        {
          end_line: fn.endLine,
          args: JSON.stringify(fn.args),
          source: fn.source?.substring(0, 5000),
          docstring: fn.docstring,
          cyclomatic_complexity: fn.cyclomaticComplexity,
          context: fn.context,
          class_context: fn.classContext,
          is_async: fn.isAsync,
          kind: fn.kind,
          lang: parsed.lang,
          repo_path: repoPath,
        },
      );
      await this.db.mergeRelationship(
        "File", { path: filePath },
        "Function", { name: fn.name, path: filePath, line_number: fn.lineNumber },
        "CONTAINS",
      );

      // Insert parameter nodes
      for (const arg of fn.args) {
        await this.db.mergeNode(
          "Parameter",
          { name: arg, function_name: fn.name, path: filePath },
          { line_number: fn.lineNumber },
        );
        await this.db.mergeRelationship(
          "Function", { name: fn.name, path: filePath, line_number: fn.lineNumber },
          "Parameter", { name: arg, function_name: fn.name, path: filePath },
          "HAS_PARAMETER",
        );
      }
    }

    // Insert classes
    for (const cls of parsed.classes) {
      const labels = cls.isInterface ? "Class:Interface" : "Class";
      await this.db.mergeNode(
        labels,
        { name: cls.name, path: filePath, line_number: cls.lineNumber },
        {
          end_line: cls.endLine,
          bases: JSON.stringify(cls.bases),
          implements: cls.implements ? JSON.stringify(cls.implements) : undefined,
          source: cls.source?.substring(0, 5000),
          docstring: cls.docstring,
          is_abstract: cls.isAbstract,
          is_interface: cls.isInterface,
          lang: parsed.lang,
          repo_path: repoPath,
        },
      );
      await this.db.mergeRelationship(
        "File", { path: filePath },
        "Class", { name: cls.name, path: filePath, line_number: cls.lineNumber },
        "CONTAINS",
      );
    }

    // Insert variables
    for (const v of parsed.variables) {
      await this.db.mergeNode(
        "Variable",
        { name: v.name, path: filePath, line_number: v.lineNumber },
        {
          value: v.value,
          type: v.type,
          context: v.context,
          class_context: v.classContext,
          lang: parsed.lang,
          repo_path: repoPath,
        },
      );
      await this.db.mergeRelationship(
        "File", { path: filePath },
        "Variable", { name: v.name, path: filePath, line_number: v.lineNumber },
        "CONTAINS",
      );
    }

    // Insert imports → Module nodes
    for (const imp of parsed.imports) {
      await this.db.mergeNode("Module", { name: imp.source }, {});
      await this.db.mergeRelationship(
        "File", { path: filePath },
        "Module", { name: imp.source },
        "IMPORTS",
        {
          imported_name: imp.name,
          alias: imp.alias,
          line_number: imp.lineNumber,
          is_default: imp.isDefault,
          is_namespace: imp.isNamespace,
        },
      );
    }

    return parsed;
  }

  /**
   * Remove a file from the graph.
   */
  async removeFile(filePath: string): Promise<void> {
    await this.db.deleteFileNodes(filePath);
  }

  /**
   * Delete an entire repository from the graph.
   */
  async deleteRepository(repoPath: string): Promise<void> {
    await this.db.deleteRepository(repoPath);
  }

  /**
   * Get statistics for an indexed repository.
   */
  async getStats(repoPath?: string): Promise<GraphStats> {
    const where = repoPath ? "WHERE n.repo_path = $repoPath" : "";
    const params = repoPath ? { repoPath } : {};

    const [repos, files, functions, classes, variables, rels] = await Promise.all([
      this.db.runQuery(
        `MATCH (r:Repository) ${repoPath ? "WHERE r.path = $repoPath" : ""} RETURN count(r) as c`,
        params,
      ),
      this.db.runQuery(`MATCH (f:File) ${repoPath ? "WHERE f.repo_path = $repoPath" : ""} RETURN count(f) as c`, params),
      this.db.runQuery(`MATCH (f:Function) ${where} RETURN count(f) as c`, params),
      this.db.runQuery(`MATCH (c:Class) ${where} RETURN count(c) as c`, params),
      this.db.runQuery(`MATCH (v:Variable) ${where} RETURN count(v) as c`, params),
      this.db.runQuery(`MATCH ()-[r]->() RETURN count(r) as c`),
    ]);

    return {
      repositories: (repos.records[0]?.get("c") as any)?.toNumber?.() ?? repos.records[0]?.get("c") ?? 0,
      files: (files.records[0]?.get("c") as any)?.toNumber?.() ?? files.records[0]?.get("c") ?? 0,
      functions: (functions.records[0]?.get("c") as any)?.toNumber?.() ?? functions.records[0]?.get("c") ?? 0,
      classes: (classes.records[0]?.get("c") as any)?.toNumber?.() ?? classes.records[0]?.get("c") ?? 0,
      variables: (variables.records[0]?.get("c") as any)?.toNumber?.() ?? variables.records[0]?.get("c") ?? 0,
      relationships: (rels.records[0]?.get("c") as any)?.toNumber?.() ?? rels.records[0]?.get("c") ?? 0,
    };
  }

  // ── Phase 1: Pre-scan ───────────────────────────────────────

  private preScanAll(files: string[]): ImportsMap {
    const combinedMap: ImportsMap = new Map();

    // Group files by parser
    const parserFiles = new Map<LanguageParser, string[]>();
    for (const f of files) {
      const parser = getParserForFile(this.parsers, f);
      if (!parser) continue;
      if (!parserFiles.has(parser)) parserFiles.set(parser, []);
      parserFiles.get(parser)!.push(f);
    }

    for (const [parser, group] of parserFiles) {
      const map = parser.preScan(group);
      for (const [name, locations] of map) {
        if (!combinedMap.has(name)) combinedMap.set(name, []);
        combinedMap.get(name)!.push(...locations);
      }
    }

    return combinedMap;
  }

  // ── Phase 3a: Inheritance links ─────────────────────────────

  private async createInheritanceLinks(
    parsed: ParsedFile,
    importsMap: ImportsMap,
  ): Promise<void> {
    for (const cls of parsed.classes) {
      for (const baseName of cls.bases) {
        // Try to resolve the base class
        const resolved = this.resolveSymbol(baseName, parsed, importsMap);
        if (resolved) {
          await this.db.runQuery(
            `MATCH (child:Class {name: $childName, path: $childPath, line_number: $childLine})
             MATCH (parent:Class {name: $parentName, path: $parentPath})
             MERGE (child)-[:INHERITS]->(parent)`,
            {
              childName: cls.name,
              childPath: parsed.path,
              childLine: cls.lineNumber,
              parentName: baseName,
              parentPath: resolved.filePath,
            },
          );
        }
      }

      // Implements links
      if (cls.implements) {
        for (const ifaceName of cls.implements) {
          const resolved = this.resolveSymbol(ifaceName, parsed, importsMap);
          if (resolved) {
            await this.db.runQuery(
              `MATCH (child:Class {name: $childName, path: $childPath, line_number: $childLine})
               MATCH (iface:Class {name: $ifaceName, path: $ifacePath})
               MERGE (child)-[:IMPLEMENTS]->(iface)`,
              {
                childName: cls.name,
                childPath: parsed.path,
                childLine: cls.lineNumber,
                ifaceName,
                ifacePath: resolved.filePath,
              },
            );
          }
        }
      }
    }
  }

  // ── Phase 3b: Call links ────────────────────────────────────

  private async createCallLinks(
    parsed: ParsedFile,
    importsMap: ImportsMap,
    allParsedFiles: ParsedFile[],
  ): Promise<void> {
    for (const call of parsed.calls) {
      if (!call.callerName) continue;

      // Resolve callee
      const resolved = this.resolveSymbol(call.name, parsed, importsMap);
      if (resolved) {
        await this.db.runQuery(
          `MATCH (caller:Function {name: $callerName, path: $callerPath})
           MATCH (callee:Function {name: $calleeName, path: $calleePath})
           MERGE (caller)-[:CALLS {line_number: $lineNumber}]->(callee)`,
          {
            callerName: call.callerName,
            callerPath: parsed.path,
            calleeName: call.name,
            calleePath: resolved.filePath,
            lineNumber: call.lineNumber,
          },
        );
      } else {
        // Try local function in same file
        const localFn = parsed.functions.find((f) => f.name === call.name);
        if (localFn) {
          await this.db.runQuery(
            `MATCH (caller:Function {name: $callerName, path: $path})
             MATCH (callee:Function {name: $calleeName, path: $path2, line_number: $calleeLine})
             MERGE (caller)-[:CALLS {line_number: $lineNumber}]->(callee)`,
            {
              callerName: call.callerName,
              path: parsed.path,
              calleeName: call.name,
              path2: parsed.path,
              calleeLine: localFn.lineNumber,
              lineNumber: call.lineNumber,
            },
          );
        }
      }
    }
  }

  // ── Symbol resolution ───────────────────────────────────────

  private resolveSymbol(
    name: string,
    parsed: ParsedFile,
    importsMap: ImportsMap,
  ): { filePath: string; lineNumber: number } | undefined {
    // 1. Check imports of this file
    const imp = parsed.imports.find((i) => i.name === name || i.alias === name);
    if (imp) {
      const locations = importsMap.get(name) ?? importsMap.get(imp.name);
      if (locations && locations.length > 0) {
        return locations[0];
      }
    }

    // 2. Check global importsMap
    const globalLocations = importsMap.get(name);
    if (globalLocations && globalLocations.length > 0) {
      // Prefer a different file over same file
      const external = globalLocations.find((l) => l.filePath !== parsed.path);
      return external ?? globalLocations[0];
    }

    return undefined;
  }

  // ── File collection ─────────────────────────────────────────

  async collectFiles(dirPath: string): Promise<string[]> {
    const extensions = this.parsers.flatMap((p) => p.supportedExtensions);
    const patterns = extensions.map((ext) => `**/*${ext}`);

    // Load .gitignore if present
    const ig = (ignore as any).default ? (ignore as any).default() : (ignore as any)();
    const gitignorePath = resolve(dirPath, ".gitignore");
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, "utf-8");
      ig.add(content);
    }
    // Always ignore node_modules, vendor, dist, .git
    ig.add(["node_modules", "vendor", "dist", ".git", "build", "coverage"]);

    const files = await globby(patterns, {
      cwd: dirPath,
      absolute: true,
      ignore: ["**/node_modules/**", "**/vendor/**", "**/dist/**", "**/.git/**", "**/build/**"],
    });

    // Apply gitignore filter
    return files.filter((f) => {
      const rel = relative(dirPath, f);
      return !ig.ignores(rel);
    });
  }
}
