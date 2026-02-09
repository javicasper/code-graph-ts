import { resolve, dirname, basename, relative, extname } from "node:path";
import ignore from "ignore";
import type {
  IndexCode,
  GraphRepository,
  FileSystem,
  JobStore,
  Logger,
} from "../domain/ports.js";
import type {
  LanguageParser,
  ParsedFile,
  ImportsMap,
  IndexJob,
} from "../domain/types.js";
import { resolveSymbol } from "../domain/symbol-resolver.js";

export class IndexCodeService implements IndexCode {
  constructor(
    private readonly graph: GraphRepository,
    private readonly fs: FileSystem,
    private readonly parsers: LanguageParser[],
    private readonly jobs: JobStore,
    private readonly logger: Logger,
  ) {}

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
    this.jobs.create(job);

    try {
      await this.graph.ensureSchema();

      const files = await this.collectFiles(absPath);
      this.jobs.update(jobId, { filesTotal: files.length });

      if (files.length === 0) {
        this.jobs.update(jobId, { status: "completed", completedAt: new Date() });
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
          this.logger.error(`Error parsing ${filePath}:`, err);
        }
        const current = this.jobs.get(jobId);
        this.jobs.update(jobId, { filesProcessed: (current?.filesProcessed ?? 0) + 1 });
      }

      // Phase 3: Link relationships (calls, inheritance)
      for (const parsed of allParsedFiles) {
        try {
          await this.createInheritanceLinks(parsed, importsMap);
          await this.createCallLinks(parsed, importsMap, allParsedFiles);
        } catch (err) {
          this.logger.error(`Error linking ${parsed.path}:`, err);
        }
      }

      this.jobs.update(jobId, { status: "completed", completedAt: new Date() });
    } catch (err) {
      this.jobs.update(jobId, {
        status: "failed",
        error: String(err),
        completedAt: new Date(),
      });
    }

    return jobId;
  }

  async indexFile(
    filePath: string,
    repoPath: string,
    importsMap: ImportsMap,
    isDependency = false,
  ): Promise<ParsedFile | null> {
    const parser = this.getParserForFile(filePath);
    if (!parser) return null;

    const sourceCode = this.fs.readFile(filePath);
    const parsed = parser.parse(sourceCode, filePath, isDependency);
    parsed.repoPath = repoPath;

    // Remove existing file nodes (for re-indexing)
    await this.graph.deleteFileNodes(filePath);

    // Insert repository node
    await this.graph.mergeNode("Repository", { path: repoPath }, {
      name: basename(repoPath),
    });

    // Insert directory hierarchy
    const relPath = relative(repoPath, filePath);
    const dirParts = dirname(relPath).split("/").filter(Boolean);
    let currentDir = repoPath;
    for (const part of dirParts) {
      const parentDir = currentDir;
      currentDir = resolve(currentDir, part);
      await this.graph.mergeNode("Directory", { path: currentDir }, {
        name: part,
      });
      if (parentDir === repoPath) {
        await this.graph.mergeRelationship(
          "Repository", { path: repoPath },
          "Directory", { path: currentDir },
          "CONTAINS_DIR",
        );
      } else {
        await this.graph.mergeRelationship(
          "Directory", { path: parentDir },
          "Directory", { path: currentDir },
          "CONTAINS_DIR",
        );
      }
    }

    // Insert file node
    await this.graph.mergeNode("File", { path: filePath }, {
      name: basename(filePath),
      lang: parsed.lang,
      repo_path: repoPath,
    });

    // File → Directory or Repository
    if (dirParts.length > 0) {
      await this.graph.mergeRelationship(
        "Directory", { path: currentDir },
        "File", { path: filePath },
        "CONTAINS_FILE",
      );
    } else {
      await this.graph.mergeRelationship(
        "Repository", { path: repoPath },
        "File", { path: filePath },
        "CONTAINS_FILE",
      );
    }

    // Insert functions
    for (const fn of parsed.functions) {
      await this.graph.mergeNode(
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
      await this.graph.mergeRelationship(
        "File", { path: filePath },
        "Function", { name: fn.name, path: filePath, line_number: fn.lineNumber },
        "CONTAINS",
      );

      // Insert parameter nodes
      for (const arg of fn.args) {
        await this.graph.mergeNode(
          "Parameter",
          { name: arg, function_name: fn.name, path: filePath },
          { line_number: fn.lineNumber },
        );
        await this.graph.mergeRelationship(
          "Function", { name: fn.name, path: filePath, line_number: fn.lineNumber },
          "Parameter", { name: arg, function_name: fn.name, path: filePath },
          "HAS_PARAMETER",
        );
      }
    }

    // Insert classes
    for (const cls of parsed.classes) {
      const labels = cls.isInterface ? "Class:Interface" : "Class";
      await this.graph.mergeNode(
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
      await this.graph.mergeRelationship(
        "File", { path: filePath },
        "Class", { name: cls.name, path: filePath, line_number: cls.lineNumber },
        "CONTAINS",
      );
    }

    // Insert variables
    for (const v of parsed.variables) {
      await this.graph.mergeNode(
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
      await this.graph.mergeRelationship(
        "File", { path: filePath },
        "Variable", { name: v.name, path: filePath, line_number: v.lineNumber },
        "CONTAINS",
      );
    }

    // Insert imports → Module nodes
    for (const imp of parsed.imports) {
      await this.graph.mergeNode("Module", { name: imp.source }, {});
      await this.graph.mergeRelationship(
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

  async removeFile(filePath: string): Promise<void> {
    await this.graph.deleteFileNodes(filePath);
  }

  async collectFiles(dirPath: string): Promise<string[]> {
    const extensions = this.parsers.flatMap((p) => p.supportedExtensions);
    const patterns = extensions.map((ext) => `**/*${ext}`);

    // Load .gitignore if present
    const ig = (ignore as any).default ? (ignore as any).default() : (ignore as any)();
    const gitignorePath = resolve(dirPath, ".gitignore");
    if (this.fs.exists(gitignorePath)) {
      const content = this.fs.readFile(gitignorePath);
      ig.add(content);
    }
    ig.add(["node_modules", "vendor", "dist", ".git", "build", "coverage"]);

    const files = await this.fs.glob(patterns, {
      cwd: dirPath,
      absolute: true,
      ignore: ["**/node_modules/**", "**/vendor/**", "**/dist/**", "**/.git/**", "**/build/**"],
    });

    return files.filter((f) => {
      const rel = relative(dirPath, f);
      return !ig.ignores(rel);
    });
  }

  // ── Private ───────────────────────────────────────────────────

  private getParserForFile(filePath: string): LanguageParser | undefined {
    const ext = extname(filePath).toLowerCase();
    return this.parsers.find((p) => p.supportedExtensions.includes(ext));
  }

  private preScanAll(files: string[]): ImportsMap {
    const combinedMap: ImportsMap = new Map();

    // Group files by parser
    const parserFiles = new Map<LanguageParser, { filePath: string; sourceCode: string }[]>();
    for (const f of files) {
      const parser = this.getParserForFile(f);
      if (!parser) continue;
      let sourceCode: string;
      try {
        sourceCode = this.fs.readFile(f);
      } catch (err) {
        this.logger.warn(`Skipping unreadable file in preScan: ${f}`, err);
        continue;
      }
      if (!parserFiles.has(parser)) parserFiles.set(parser, []);
      parserFiles.get(parser)!.push({ filePath: f, sourceCode });
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

  private async createInheritanceLinks(
    parsed: ParsedFile,
    importsMap: ImportsMap,
  ): Promise<void> {
    for (const cls of parsed.classes) {
      for (const baseName of cls.bases) {
        const resolved = resolveSymbol(baseName, parsed, importsMap);
        if (resolved) {
          await this.graph.runQuery(
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

      if (cls.implements) {
        for (const ifaceName of cls.implements) {
          const resolved = resolveSymbol(ifaceName, parsed, importsMap);
          if (resolved) {
            await this.graph.runQuery(
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

  private async createCallLinks(
    parsed: ParsedFile,
    importsMap: ImportsMap,
    allParsedFiles: ParsedFile[],
  ): Promise<void> {
    for (const call of parsed.calls) {
      if (!call.callerName) continue;

      const resolved = resolveSymbol(call.name, parsed, importsMap);
      if (resolved) {
        await this.graph.runQuery(
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
          await this.graph.runQuery(
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
}
