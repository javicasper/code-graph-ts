import { resolve } from "node:path";
import { getDatabase } from "../core/database.js";
import { GraphBuilder, getJob, getAllJobs } from "../core/graph-builder.js";
import { FileWatcher } from "../core/watcher.js";

const db = getDatabase();
const builder = new GraphBuilder(db);
const watcher = new FileWatcher(builder);

// ── Tool definitions ────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "add_code_to_graph",
    description: "Index a directory of source code into the Neo4j graph. Supports JS, TS, TSX, and PHP files.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the directory to index" },
        is_dependency: { type: "boolean", description: "If true, skips storing source code to save space", default: false },
      },
      required: ["path"],
    },
  },
  {
    name: "find_code",
    description: "Full-text search for functions, classes, or variables by name in the graph.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (supports fuzzy matching)" },
        limit: { type: "number", description: "Maximum results to return", default: 20 },
      },
      required: ["query"],
    },
  },
  {
    name: "analyze_code_relationships",
    description: "Analyze code relationships: find_callers, find_callees, class_hierarchy, dead_code, call_chain, find_importers, module_deps, find_complexity.",
    inputSchema: {
      type: "object",
      properties: {
        analysis_type: {
          type: "string",
          enum: [
            "find_callers", "find_callees", "class_hierarchy",
            "dead_code", "call_chain", "find_importers",
            "module_deps", "find_complexity",
          ],
          description: "Type of analysis to perform",
        },
        name: { type: "string", description: "Function or class name to analyze" },
        limit: { type: "number", description: "Maximum results", default: 20 },
        depth: { type: "number", description: "Max depth for call chains / hierarchy", default: 5 },
      },
      required: ["analysis_type"],
    },
  },
  {
    name: "execute_cypher_query",
    description: "Execute a read-only Cypher query against the Neo4j graph.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Cypher query (read-only)" },
        params: { type: "object", description: "Query parameters" },
      },
      required: ["query"],
    },
  },
  {
    name: "watch_directory",
    description: "Start watching a directory for file changes and auto-update the graph.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path to watch" },
      },
      required: ["path"],
    },
  },
  {
    name: "unwatch_directory",
    description: "Stop watching a directory.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path to stop watching" },
      },
      required: ["path"],
    },
  },
  {
    name: "list_watched_paths",
    description: "List all currently watched directory paths.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "calculate_cyclomatic_complexity",
    description: "Get the cyclomatic complexity of a specific function.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Function name" },
        path: { type: "string", description: "File path (optional, to disambiguate)" },
      },
      required: ["name"],
    },
  },
  {
    name: "find_most_complex_functions",
    description: "Find the top N most complex functions by cyclomatic complexity.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of results", default: 10 },
        repo_path: { type: "string", description: "Filter by repository path" },
      },
    },
  },
  {
    name: "find_dead_code",
    description: "Find functions that have no callers (potential dead code).",
    inputSchema: {
      type: "object",
      properties: {
        repo_path: { type: "string", description: "Filter by repository path" },
        limit: { type: "number", default: 50 },
      },
    },
  },
  {
    name: "list_indexed_repositories",
    description: "List all repositories that have been indexed in the graph.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "delete_repository",
    description: "Remove a repository and all its data from the graph.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository path to delete" },
        all: { type: "boolean", description: "Delete ALL repositories", default: false },
      },
    },
  },
  {
    name: "check_job_status",
    description: "Check the status of an indexing job.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Job ID to check. Omit to list all jobs." },
      },
    },
  },
];

// ── Tool handler ────────────────────────────────────────────────

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "add_code_to_graph": {
      const dirPath = resolve(args.path as string);
      const isDependency = (args.is_dependency as boolean) ?? false;
      const jobId = await builder.indexDirectory(dirPath, isDependency);
      const job = getJob(jobId);
      return { jobId, status: job?.status, filesTotal: job?.filesTotal, filesProcessed: job?.filesProcessed };
    }

    case "find_code": {
      const query = args.query as string;
      const limit = (args.limit as number) ?? 20;
      try {
        const result = await db.runQuery(
          `CALL db.index.fulltext.queryNodes("code_search", $query)
           YIELD node, score
           RETURN labels(node) as labels, node.name as name, node.path as path,
                  node.line_number as line_number, score
           ORDER BY score DESC LIMIT $limit`,
          { query, limit },
        );
        return result.records.map((r) => ({
          labels: r.get("labels"),
          name: r.get("name"),
          path: r.get("path"),
          lineNumber: toNumber(r.get("line_number")),
          score: r.get("score"),
        }));
      } catch {
        // Fulltext index may not exist; fall back to CONTAINS
        const result = await db.runQuery(
          `MATCH (n) WHERE (n:Function OR n:Class OR n:Variable) AND n.name CONTAINS $query
           RETURN labels(n) as labels, n.name as name, n.path as path, n.line_number as line_number
           LIMIT $limit`,
          { query, limit },
        );
        return result.records.map((r) => ({
          labels: r.get("labels"),
          name: r.get("name"),
          path: r.get("path"),
          lineNumber: toNumber(r.get("line_number")),
        }));
      }
    }

    case "analyze_code_relationships": {
      const type = args.analysis_type as string;
      const fnName = args.name as string;
      const limit = (args.limit as number) ?? 20;
      const depth = (args.depth as number) ?? 5;
      return analyzeRelationships(type, fnName, limit, depth);
    }

    case "execute_cypher_query": {
      const query = args.query as string;
      const params = (args.params as Record<string, unknown>) ?? {};
      // Enforce read-only
      const upper = query.trim().toUpperCase();
      if (
        upper.startsWith("CREATE") ||
        upper.startsWith("MERGE") ||
        upper.startsWith("DELETE") ||
        upper.startsWith("SET") ||
        upper.startsWith("REMOVE") ||
        upper.startsWith("DROP")
      ) {
        return { error: "Only read-only queries are allowed." };
      }
      const result = await db.runQuery(query, params);
      return result.records.map((r) => r.toObject());
    }

    case "watch_directory": {
      const dirPath = resolve(args.path as string);
      await watcher.watch(dirPath);
      return { status: "watching", path: dirPath };
    }

    case "unwatch_directory": {
      const dirPath = resolve(args.path as string);
      await watcher.unwatch(dirPath);
      return { status: "unwatched", path: dirPath };
    }

    case "list_watched_paths": {
      return { paths: watcher.getWatchedPaths() };
    }

    case "calculate_cyclomatic_complexity": {
      const fnName = args.name as string;
      const path = args.path as string | undefined;
      const where = path
        ? "WHERE f.name = $name AND f.path = $path"
        : "WHERE f.name = $name";
      const result = await db.runQuery(
        `MATCH (f:Function) ${where}
         RETURN f.name as name, f.path as path, f.line_number as line_number,
                f.cyclomatic_complexity as complexity`,
        { name: fnName, path },
      );
      return result.records.map((r) => ({
        name: r.get("name"),
        path: r.get("path"),
        lineNumber: toNumber(r.get("line_number")),
        complexity: toNumber(r.get("complexity")),
      }));
    }

    case "find_most_complex_functions": {
      const limit = (args.limit as number) ?? 10;
      const repoPath = args.repo_path as string | undefined;
      const where = repoPath ? "WHERE f.repo_path = $repoPath" : "";
      const result = await db.runQuery(
        `MATCH (f:Function) ${where}
         RETURN f.name as name, f.path as path, f.line_number as line_number,
                f.cyclomatic_complexity as complexity
         ORDER BY f.cyclomatic_complexity DESC LIMIT $limit`,
        { limit, repoPath },
      );
      return result.records.map((r) => ({
        name: r.get("name"),
        path: r.get("path"),
        lineNumber: toNumber(r.get("line_number")),
        complexity: toNumber(r.get("complexity")),
      }));
    }

    case "find_dead_code": {
      const limit = (args.limit as number) ?? 50;
      const repoPath = args.repo_path as string | undefined;
      const where = repoPath ? "AND f.repo_path = $repoPath" : "";
      const result = await db.runQuery(
        `MATCH (f:Function)
         WHERE NOT ()-[:CALLS]->(f) ${where}
           AND f.kind IS NULL OR f.kind <> 'constructor'
         RETURN f.name as name, f.path as path, f.line_number as line_number
         LIMIT $limit`,
        { limit, repoPath },
      );
      return result.records.map((r) => ({
        name: r.get("name"),
        path: r.get("path"),
        lineNumber: toNumber(r.get("line_number")),
      }));
    }

    case "list_indexed_repositories": {
      const result = await db.runQuery(
        `MATCH (r:Repository) RETURN r.path as path, r.name as name`,
      );
      return result.records.map((r) => ({
        path: r.get("path"),
        name: r.get("name"),
      }));
    }

    case "delete_repository": {
      if (args.all) {
        await db.runQuery("MATCH (n) DETACH DELETE n");
        return { status: "deleted_all" };
      }
      const repoPath = resolve(args.path as string);
      await builder.deleteRepository(repoPath);
      return { status: "deleted", path: repoPath };
    }

    case "check_job_status": {
      const jobId = args.job_id as string | undefined;
      if (jobId) {
        const job = getJob(jobId);
        return job ?? { error: "Job not found" };
      }
      return getAllJobs();
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── Analysis queries ────────────────────────────────────────────

async function analyzeRelationships(
  type: string,
  name: string,
  limit: number,
  depth: number,
): Promise<unknown> {
  switch (type) {
    case "find_callers": {
      const result = await db.runQuery(
        `MATCH (caller:Function)-[r:CALLS]->(callee:Function {name: $name})
         RETURN caller.name as caller_name, caller.path as caller_path,
                caller.line_number as caller_line, r.line_number as call_line
         LIMIT $limit`,
        { name, limit },
      );
      return result.records.map((r) => ({
        callerName: r.get("caller_name"),
        callerPath: r.get("caller_path"),
        callerLine: toNumber(r.get("caller_line")),
        callLine: toNumber(r.get("call_line")),
      }));
    }

    case "find_callees": {
      const result = await db.runQuery(
        `MATCH (caller:Function {name: $name})-[r:CALLS]->(callee:Function)
         RETURN callee.name as callee_name, callee.path as callee_path,
                callee.line_number as callee_line, r.line_number as call_line
         LIMIT $limit`,
        { name, limit },
      );
      return result.records.map((r) => ({
        calleeName: r.get("callee_name"),
        calleePath: r.get("callee_path"),
        calleeLine: toNumber(r.get("callee_line")),
        callLine: toNumber(r.get("call_line")),
      }));
    }

    case "class_hierarchy": {
      const result = await db.runQuery(
        `MATCH path = (c:Class {name: $name})-[:INHERITS*0..${depth}]->(parent:Class)
         RETURN [n in nodes(path) | n.name] as hierarchy`,
        { name },
      );
      return result.records.map((r) => r.get("hierarchy"));
    }

    case "dead_code": {
      const result = await db.runQuery(
        `MATCH (f:Function)
         WHERE NOT ()-[:CALLS]->(f)
         RETURN f.name as name, f.path as path, f.line_number as line_number
         LIMIT $limit`,
        { limit },
      );
      return result.records.map((r) => ({
        name: r.get("name"),
        path: r.get("path"),
        lineNumber: toNumber(r.get("line_number")),
      }));
    }

    case "call_chain": {
      const result = await db.runQuery(
        `MATCH path = (start:Function {name: $name})-[:CALLS*1..${depth}]->(end:Function)
         RETURN [n in nodes(path) | n.name] as chain
         LIMIT $limit`,
        { name, limit },
      );
      return result.records.map((r) => r.get("chain"));
    }

    case "find_importers": {
      const result = await db.runQuery(
        `MATCH (f:File)-[r:IMPORTS]->(m:Module)
         WHERE r.imported_name = $name OR m.name CONTAINS $name
         RETURN f.path as file_path, m.name as module, r.imported_name as imported_name
         LIMIT $limit`,
        { name, limit },
      );
      return result.records.map((r) => ({
        filePath: r.get("file_path"),
        module: r.get("module"),
        importedName: r.get("imported_name"),
      }));
    }

    case "module_deps": {
      const result = await db.runQuery(
        `MATCH (f:File)-[:IMPORTS]->(m:Module)
         WHERE f.path CONTAINS $name OR f.name = $name
         RETURN DISTINCT m.name as module
         LIMIT $limit`,
        { name, limit },
      );
      return result.records.map((r) => r.get("module"));
    }

    case "find_complexity": {
      const result = await db.runQuery(
        `MATCH (f:Function)
         WHERE f.name CONTAINS $name
         RETURN f.name as name, f.path as path, f.cyclomatic_complexity as complexity
         ORDER BY f.cyclomatic_complexity DESC
         LIMIT $limit`,
        { name, limit },
      );
      return result.records.map((r) => ({
        name: r.get("name"),
        path: r.get("path"),
        complexity: toNumber(r.get("complexity")),
      }));
    }

    default:
      return { error: `Unknown analysis type: ${type}` };
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function toNumber(val: unknown): number | undefined {
  if (val == null) return undefined;
  if (typeof val === "number") return val;
  if (typeof (val as any).toNumber === "function") return (val as any).toNumber();
  return Number(val);
}
