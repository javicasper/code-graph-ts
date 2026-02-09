#!/usr/bin/env node

import "dotenv/config";
import { Command } from "commander";
import { resolve } from "node:path";
import { loadConfig } from "../../config.js";
import { createAppServices } from "../../composition-root.js";
import { startMCPServer } from "../mcp/server.js";

const config = loadConfig();
const services = createAppServices(config);
const { graph, indexCode, analyzeCode, manageRepos, watchFiles: watchService, jobs } = services;

const program = new Command();

program
  .name("codegraph")
  .description("Index source code into a Neo4j graph for AI assistants")
  .version("1.0.0");

// ── index ───────────────────────────────────────────────────────

program
  .command("index")
  .description("Index a directory of source code")
  .argument("[path]", "Directory to index", ".")
  .option("--dependency", "Mark as dependency (skip storing source code)")
  .action(async (path: string, opts: { dependency?: boolean }) => {
    const absPath = resolve(path);
    console.log(`Indexing: ${absPath}`);

    try {
      await graph.verifyConnectivity();
      const jobId = await indexCode.indexDirectory(absPath, opts.dependency);
      const job = jobs.get(jobId);
      console.log(`Done! Job: ${jobId}`);
      console.log(`  Status: ${job?.status}`);
      console.log(`  Files: ${job?.filesProcessed}/${job?.filesTotal}`);
      if (job?.error) console.log(`  Error: ${job.error}`);
    } catch (err) {
      console.error("Error:", err);
      process.exitCode = 1;
    } finally {
      await graph.close();
    }
  });

// ── list ────────────────────────────────────────────────────────

program
  .command("list")
  .description("List indexed repositories")
  .action(async () => {
    try {
      await graph.verifyConnectivity();
      const repos = await manageRepos.listRepositories();
      if (repos.length === 0) {
        console.log("No repositories indexed.");
      } else {
        console.log("Indexed repositories:");
        for (const r of repos) {
          console.log(`  ${r.name} → ${r.path}`);
        }
      }
    } catch (err) {
      console.error("Error:", err);
      process.exitCode = 1;
    } finally {
      await graph.close();
    }
  });

// ── delete ──────────────────────────────────────────────────────

program
  .command("delete")
  .description("Delete a repository from the graph")
  .argument("[path]", "Repository path to delete")
  .option("--all", "Delete all repositories")
  .action(async (path: string | undefined, opts: { all?: boolean }) => {
    try {
      await graph.verifyConnectivity();
      if (opts.all) {
        await manageRepos.deleteAll();
        console.log("All data deleted.");
      } else if (path) {
        const absPath = resolve(path);
        await manageRepos.deleteRepository(absPath);
        console.log(`Deleted: ${absPath}`);
      } else {
        console.error("Specify a path or use --all");
        process.exitCode = 1;
      }
    } catch (err) {
      console.error("Error:", err);
      process.exitCode = 1;
    } finally {
      await graph.close();
    }
  });

// ── stats ───────────────────────────────────────────────────────

program
  .command("stats")
  .description("Show graph statistics")
  .argument("[path]", "Filter by repository path")
  .action(async (path?: string) => {
    try {
      await graph.verifyConnectivity();
      const repoPath = path ? resolve(path) : undefined;
      const stats = await manageRepos.getStats(repoPath);
      console.log("Graph Statistics:");
      console.log(`  Repositories:  ${stats.repositories}`);
      console.log(`  Files:         ${stats.files}`);
      console.log(`  Functions:     ${stats.functions}`);
      console.log(`  Classes:       ${stats.classes}`);
      console.log(`  Variables:     ${stats.variables}`);
      console.log(`  Relationships: ${stats.relationships}`);
    } catch (err) {
      console.error("Error:", err);
      process.exitCode = 1;
    } finally {
      await graph.close();
    }
  });

// ── watch ───────────────────────────────────────────────────────

program
  .command("watch")
  .description("Watch a directory for changes and update the graph")
  .argument("[path]", "Directory to watch", ".")
  .action(async (path: string) => {
    const absPath = resolve(path);

    try {
      await graph.verifyConnectivity();
      console.log(`Watching: ${absPath}`);
      console.log("Press Ctrl+C to stop.");
      await watchService.watch(absPath);

      process.on("SIGINT", async () => {
        console.log("\nStopping watcher...");
        await watchService.closeAll();
        await graph.close();
        process.exit(0);
      });
    } catch (err) {
      console.error("Error:", err);
      await graph.close();
      process.exitCode = 1;
    }
  });

// ── analyze ─────────────────────────────────────────────────────

const analyze = program
  .command("analyze")
  .description("Analyze code relationships");

analyze
  .command("callers")
  .description("Find who calls a function")
  .argument("<func>", "Function name")
  .action(async (func: string) => {
    try {
      await graph.verifyConnectivity();
      const results = await analyzeCode.findCallers(func, 50);
      if (results.length === 0) {
        console.log(`No callers found for "${func}".`);
      } else {
        console.log(`Callers of "${func}":`);
        for (const r of results) {
          console.log(`  ${r.callerName} (${r.callerPath}:${r.callLine ?? "?"})`);
        }
      }
    } catch (err) {
      console.error("Error:", err);
      process.exitCode = 1;
    } finally {
      await graph.close();
    }
  });

analyze
  .command("callees")
  .description("Find what a function calls")
  .argument("<func>", "Function name")
  .action(async (func: string) => {
    try {
      await graph.verifyConnectivity();
      const results = await analyzeCode.findCallees(func, 50);
      if (results.length === 0) {
        console.log(`"${func}" doesn't call any tracked functions.`);
      } else {
        console.log(`"${func}" calls:`);
        for (const r of results) {
          console.log(`  ${r.calleeName} (${r.calleePath}:${r.callLine ?? "?"})`);
        }
      }
    } catch (err) {
      console.error("Error:", err);
      process.exitCode = 1;
    } finally {
      await graph.close();
    }
  });

analyze
  .command("hierarchy")
  .description("Show class hierarchy")
  .argument("<class>", "Class name")
  .action(async (className: string) => {
    try {
      await graph.verifyConnectivity();
      const results = await analyzeCode.classHierarchy(className, 10);
      if (results.length === 0) {
        console.log(`No hierarchy found for "${className}".`);
      } else {
        console.log(`Hierarchy for "${className}":`);
        for (const chain of results) {
          console.log(`  ${chain.join(" → ")}`);
        }
      }
    } catch (err) {
      console.error("Error:", err);
      process.exitCode = 1;
    } finally {
      await graph.close();
    }
  });

analyze
  .command("dead-code")
  .description("Find functions with no callers")
  .option("-l, --limit <n>", "Max results", "20")
  .action(async (opts: { limit: string }) => {
    try {
      await graph.verifyConnectivity();
      const results = await analyzeCode.deadCode(parseInt(opts.limit, 10));
      if (results.length === 0) {
        console.log("No dead code found.");
      } else {
        console.log("Potentially dead functions:");
        for (const r of results) {
          console.log(`  ${r.name} (${r.path}:${r.lineNumber ?? "?"})`);
        }
      }
    } catch (err) {
      console.error("Error:", err);
      process.exitCode = 1;
    } finally {
      await graph.close();
    }
  });

analyze
  .command("complexity")
  .description("Find most complex functions")
  .option("-l, --limit <n>", "Max results", "10")
  .action(async (opts: { limit: string }) => {
    try {
      await graph.verifyConnectivity();
      const results = await analyzeCode.mostComplexFunctions(parseInt(opts.limit, 10));
      if (results.length === 0) {
        console.log("No functions found.");
      } else {
        console.log("Most complex functions:");
        for (const r of results) {
          console.log(`  [${r.complexity ?? "?"}] ${r.name} (${r.path})`);
        }
      }
    } catch (err) {
      console.error("Error:", err);
      process.exitCode = 1;
    } finally {
      await graph.close();
    }
  });

// ── mcp ─────────────────────────────────────────────────────────

const mcp = program.command("mcp").description("MCP server commands");

mcp
  .command("start")
  .description("Start the MCP server (stdio transport)")
  .action(async () => {
    try {
      await startMCPServer(services);
    } catch (err) {
      console.error("MCP server error:", err);
      process.exitCode = 1;
    }
  });

// ── Run ─────────────────────────────────────────────────────────

program.parse();
