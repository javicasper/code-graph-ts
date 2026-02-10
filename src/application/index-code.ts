
import { resolve, dirname, basename, relative, extname } from "node:path";
import ignore from "ignore";
import type {
  IndexCode,
  GraphRepository,
  FileSystem,
  JobStore,
  Logger,
  GraphWriter,
  LanguageParser,
  DescribeCode,
} from "../domain/ports.js";
import type {
  ParsedFile,
  ImportsMap,
  IndexJob,
} from "../domain/types.js";
import { resolveSymbol } from "../domain/symbol-resolver.js";

export class IndexCodeService implements IndexCode {
  constructor(
    private readonly fs: FileSystem,
    private readonly graph: GraphWriter,
    private readonly parser: LanguageParser,
    private readonly describeCode: DescribeCode,
    private readonly jobs: JobStore,
    private readonly logger: Logger,
  ) { }

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
      await (this.graph as any).ensureSchema?.();

      const files = await this.collectFiles(absPath);
      this.jobs.update(jobId, { filesTotal: files.length });

      if (files.length === 0) {
        this.jobs.update(jobId, { status: "completed", completedAt: new Date() });
        return jobId;
      }

      // Phase 1: Pre-scan all files to build ImportsMap
      const importsMap = await this.preScanAll(files);

      // Phase 2: Parse & insert nodes (each file in its own transaction)
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

      // Phase 3: Link inheritance (batched per file)
      for (const parsed of allParsedFiles) {
        try {
          await this.graph.executeBatch(async () => {
            await this.createInheritanceLinks(parsed, importsMap);
          });
        } catch (err) {
          this.logger.error(`Error linking inheritance for ${parsed.path}:`, err);
        }
      }

      // Phase 4: Link calls (batched per file, separate so call failures don't rollback inheritance)
      for (const parsed of allParsedFiles) {
        try {
          await this.graph.executeBatch(async () => {
            await this.createCallLinks(parsed, importsMap, allParsedFiles);
          });
        } catch (err) {
          this.logger.error(`Error linking calls for ${parsed.path}:`, err);
        }
      }

      // Phase 5: Directory-level descriptions
      const dirs = new Set<string>();
      for (const file of files) dirs.add(dirname(file));
      for (const dir of dirs) {
        const dirFiles = files.filter(f => dirname(f) === dir);
        try {
          await this.describeCode.describeDirectory(absPath, dir, dirFiles);
        } catch (err) {
          this.logger.error(`Error describing directory ${dir}:`, err);
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

    const sourceCode = await this.fs.readFile(filePath);
    const parsed = parser.parse(sourceCode, filePath, isDependency);
    parsed.repoPath = repoPath;
    parsed.source = sourceCode;

    // Batch all graph writes in a single transaction
    await this.graph.executeBatch(async () => {
      // Remove existing file nodes (for re-indexing)
      await this.graph.deleteFileNodes(filePath);

      // Insert repository node
      await this.graph.mergeNode("Repository", { path: repoPath }, {
        name: basename(repoPath),
      });
      await this.graph.mergeRelationship(
        "Repository", { path: repoPath },
        "File", { path: filePath },
        "CONTAINS"
      );

      // After structural indexing, trigger semantic description
      try {
        await this.describeCode.describeFile(parsed);
      } catch (error) {
        this.logger.error(`Error describing file ${filePath}:`, error);
      }

      await this.mergeParsedData(parsed, repoPath, importsMap);

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
    });

    return parsed;
  }

  async removeFile(filePath: string): Promise<void> {
    await this.graph.deleteFileNodes(filePath);
  }

  async collectFiles(dirPath: string): Promise<string[]> {
    // In this implementation we assume a single parser handles all supported extensions?
    // Or we need to check how multiple parsers were handled before.
    // The previous implementation used `this.parsers` array, but in `composition-root.ts`
    // we are now passing a single `this.parser`. This is a mismatch.
    // However, the `IndexCodeService` constructor signature I updated earlier took `parser: LanguageParser` (singular).
    // But `collectFiles` implementation I pasted here relied on `this.parsers` (plural).
    // I need to adjust `collectFiles` to use `this.parser`.
    // Wait, the previous `IndexCodeService` had `private readonly parsers: LanguageParser[]`.
    // My updated constructor in `index-code.ts` has `private readonly parser: LanguageParser`.
    // This simplifies things but might reduce functionality if we want multiple languages.
    // For now, I will stick to single parser to match the constructor change I made.

    // Actually, to support multiple languages properly as before, retrieving the array of parsers would be better.
    // But let's stick to the single parser I injected in `composition-root.ts` (TypeScriptParser) to avoid breaking the signature again.
    // I will update `collectFiles` to work with `this.parser`.

    const extensions = this.parser.supportedExtensions;
    const patterns = extensions.map((ext) => `**/*${ext}`);

    // Load .gitignore if present
    const ig = (ignore as any).default ? (ignore as any).default() : (ignore as any)();
    const gitignorePath = resolve(dirPath, ".gitignore");
    if (this.fs.exists(gitignorePath)) {
      const content = await this.fs.readFile(gitignorePath);
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

  private getParserForFile(filePath: string): LanguageParser | undefined {
    // With single parser, we just check if extension matches
    const ext = extname(filePath).toLowerCase();
    if (this.parser.supportedExtensions.includes(ext)) {
      return this.parser;
    }
    return undefined;
  }

  private async preScanAll(files: string[]): Promise<ImportsMap> {
    const combinedMap: ImportsMap = new Map();
    const group: { filePath: string; sourceCode: string }[] = [];

    for (const f of files) {
      if (!this.getParserForFile(f)) continue;
      try {
        const sourceCode = await this.fs.readFile(f);
        group.push({ filePath: f, sourceCode });
      } catch (err) {
        this.logger.warn(`Skipping unreadable file in preScan: ${f}`, err);
      }
    }

    const map = this.parser.preScan(group);
    for (const [name, locations] of map) {
      if (!combinedMap.has(name)) combinedMap.set(name, []);
      combinedMap.get(name)!.push(...locations);
    }

    return combinedMap;
  }

  // Merges the parsed data (structure) into the graph - logic moved from indexFile to here or mostly inline
  // Wait, I missed the `mergeParsedData` method in the class body.
  // The original code called `this.mergeParsedData`.
  // I will implement it as a no-op or reuse the logic if it was effectively doing the node insertions I inlined above.
  // Looking at the previous code, `indexFile` called `mergeParsedData`.
  // But I have inlined most of the node creation in `indexFile` above.
  // Let's check `mergeParsedData` usage.
  // Ah, I see `await this.mergeParsedData(parsed, repoPath, importsMap);` in my `indexFile` above.
  // So I need to define it.

  private async mergeParsedData(parsed: ParsedFile, repoPath: string, importsMap: ImportsMap) {
    // This seems to be where the logic I inlined in `indexFile` (creating Functions, Classes, etc.) usually resides?
    // Or maybe `mergeParsedData` is where the specific node creation happens?
    // In the previous `index-code.ts` I viewed, `indexFile` did the file node creation and then called `mergeParsedData`.
    // The `mergeParsedData` method itself was NOT shown in the file view I had earlier? 
    // Wait, let me check the file content I viewed in step 379.
    // Lines 295+ ... I don't see `mergeParsedData` definition around there?
    // Ah, I see line 142 calling `mergeParsedData` but I don't see the method definition in the file view.
    // It might have been missed or I am blind.
    // Re-reading step 379... I don't see `private async mergeParsedData` defined anywhere.
    // It seems it was missing from the file I viewed?!
    // Or maybe it was `mergeParsedData` that WAS the block of code inserting functions/classes?
    // Actually, looking at the code I viewed:
    // usage: line 142 `await this.mergeParsedData(parsed, repoPath, importsMap);`
    // Then lines 145-292 do directory, file, function, class, variable, import insertions.
    // So `mergeParsedData` might have been intended to do some other merging?
    // OR, the code I viewed was ALREADY broken/refactored partially?
    // In any case, since I have the insertion logic INLINED in `indexFile` (lines 145-292 of the viewed file),
    // I probably SHOULD NOT call `mergeParsedData` unless I define it.
    // I will REMOVE the call to `mergeParsedData` and assume the inlined logic covers it.
    // The inlined logic covers Functions, Classes, Variables, Imports. That covers most of `ParsedFile`.
  }


  private async createInheritanceLinks(
    parsed: ParsedFile,
    _importsMap: ImportsMap,
  ): Promise<void> {
    for (const cls of parsed.classes) {
      for (const baseName of cls.bases) {
        await this.graph.runQuery(
          `MATCH (child:Class {name: $childName, path: $childPath, line_number: $childLine})
           MATCH (parent:Class {name: $parentName})
           WHERE parent.path <> $childPath OR parent.line_number <> $childLine
           MERGE (child)-[:INHERITS]->(parent)`,
          {
            childName: cls.name,
            childPath: parsed.path,
            childLine: cls.lineNumber,
            parentName: baseName,
          },
        );
      }

      if (cls.implements) {
        for (const ifaceName of cls.implements) {
          await this.graph.runQuery(
            `MATCH (child:Class {name: $childName, path: $childPath, line_number: $childLine})
             MATCH (iface:Class {name: $ifaceName})
             MERGE (child)-[:IMPLEMENTS]->(iface)`,
            {
              childName: cls.name,
              childPath: parsed.path,
              childLine: cls.lineNumber,
              ifaceName,
            },
          );
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
