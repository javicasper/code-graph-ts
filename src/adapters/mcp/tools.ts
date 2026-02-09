import { resolve } from "node:path";
import type { AppServices } from "../../composition-root.js";

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

// ── Tool handler factory ────────────────────────────────────────

export function createToolHandler(services: AppServices) {
  const { indexCode, searchCode, analyzeCode, watchFiles, manageRepos, jobs } = services;

  return async function handleToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    switch (name) {
      case "add_code_to_graph": {
        const dirPath = resolve(args.path as string);
        const isDependency = (args.is_dependency as boolean) ?? false;
        const jobId = await indexCode.indexDirectory(dirPath, isDependency);
        const job = jobs.get(jobId);
        return {
          jobId,
          status: job?.status,
          filesTotal: job?.filesTotal,
          filesProcessed: job?.filesProcessed,
        };
      }

      case "find_code": {
        const query = args.query as string;
        const limit = (args.limit as number) ?? 20;
        return searchCode.fulltextSearch(query, limit);
      }

      case "analyze_code_relationships": {
        const type = args.analysis_type as string;
        const fnName = args.name as string;
        const limit = (args.limit as number) ?? 20;
        const depth = (args.depth as number) ?? 5;
        return analyzeRelationships(analyzeCode, type, fnName, limit, depth);
      }

      case "execute_cypher_query": {
        const query = args.query as string;
        const params = (args.params as Record<string, unknown>) ?? {};
        try {
          return await searchCode.cypherQuery(query, params);
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      }

      case "watch_directory": {
        const dirPath = resolve(args.path as string);
        await watchFiles.watch(dirPath);
        return { status: "watching", path: dirPath };
      }

      case "unwatch_directory": {
        const dirPath = resolve(args.path as string);
        await watchFiles.unwatch(dirPath);
        return { status: "unwatched", path: dirPath };
      }

      case "list_watched_paths": {
        return { paths: watchFiles.getWatchedPaths() };
      }

      case "calculate_cyclomatic_complexity": {
        const fnName = args.name as string;
        const path = args.path as string | undefined;
        return analyzeCode.calculateComplexity(fnName, path);
      }

      case "find_most_complex_functions": {
        const limit = (args.limit as number) ?? 10;
        const repoPath = args.repo_path as string | undefined;
        return analyzeCode.mostComplexFunctions(limit, repoPath);
      }

      case "find_dead_code": {
        const limit = (args.limit as number) ?? 50;
        const repoPath = args.repo_path as string | undefined;
        return analyzeCode.deadCode(limit, repoPath);
      }

      case "list_indexed_repositories": {
        return manageRepos.listRepositories();
      }

      case "delete_repository": {
        if (args.all) {
          await manageRepos.deleteAll();
          return { status: "deleted_all" };
        }
        const repoPath = resolve(args.path as string);
        await manageRepos.deleteRepository(repoPath);
        return { status: "deleted", path: repoPath };
      }

      case "check_job_status": {
        const jobId = args.job_id as string | undefined;
        if (jobId) {
          const job = jobs.get(jobId);
          return job ?? { error: "Job not found" };
        }
        return jobs.getAll();
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  };
}

// ── Analysis dispatcher ─────────────────────────────────────────

async function analyzeRelationships(
  analyzeCode: AppServices["analyzeCode"],
  type: string,
  name: string,
  limit: number,
  depth: number,
): Promise<unknown> {
  switch (type) {
    case "find_callers":
      return analyzeCode.findCallers(name, limit);
    case "find_callees":
      return analyzeCode.findCallees(name, limit);
    case "class_hierarchy":
      return analyzeCode.classHierarchy(name, depth);
    case "dead_code":
      return analyzeCode.deadCode(limit);
    case "call_chain":
      return analyzeCode.callChain(name, depth, limit);
    case "find_importers":
      return analyzeCode.findImporters(name, limit);
    case "module_deps":
      return analyzeCode.moduleDeps(name, limit);
    case "find_complexity":
      return analyzeCode.findComplexity(name, limit);
    default:
      return { error: `Unknown analysis type: ${type}` };
  }
}
