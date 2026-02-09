#!/usr/bin/env node

import "dotenv/config";
import { Command } from "commander";
import { resolve } from "node:path";
import { getDatabase, closeDatabase } from "../core/database.js";
import { GraphBuilder, getJob } from "../core/graph-builder.js";
import { FileWatcher } from "../core/watcher.js";
import { startMCPServer } from "../mcp/server.js";

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

    const db = getDatabase();
    const builder = new GraphBuilder(db);

    try {
      await db.verifyConnectivity();
      const jobId = await builder.indexDirectory(absPath, opts.dependency);
      const job = getJob(jobId);
      console.log(`Done! Job: ${jobId}`);
      console.log(`  Status: ${job?.status}`);
      console.log(`  Files: ${job?.filesProcessed}/${job?.filesTotal}`);
      if (job?.error) console.log(`  Error: ${job.error}`);
    } catch (err) {
      console.error("Error:", err);
      process.exitCode = 1;
    } finally {
      await closeDatabase();
    }
  });

// ── list ────────────────────────────────────────────────────────

program
  .command("list")
  .description("List indexed repositories")
  .action(async () => {
    const db = getDatabase();
    try {
      await db.verifyConnectivity();
      const result = await db.runQuery(
        "MATCH (r:Repository) RETURN r.path as path, r.name as name",
      );
      if (result.records.length === 0) {
        console.log("No repositories indexed.");
      } else {
        console.log("Indexed repositories:");
        for (const r of result.records) {
          console.log(`  ${r.get("name")} → ${r.get("path")}`);
        }
      }
    } catch (err) {
      console.error("Error:", err);
      process.exitCode = 1;
    } finally {
      await closeDatabase();
    }
  });

// ── delete ──────────────────────────────────────────────────────

program
  .command("delete")
  .description("Delete a repository from the graph")
  .argument("[path]", "Repository path to delete")
  .option("--all", "Delete all repositories")
  .action(async (path: string | undefined, opts: { all?: boolean }) => {
    const db = getDatabase();
    const builder = new GraphBuilder(db);

    try {
      await db.verifyConnectivity();
      if (opts.all) {
        await db.runQuery("MATCH (n) DETACH DELETE n");
        console.log("All data deleted.");
      } else if (path) {
        const absPath = resolve(path);
        await builder.deleteRepository(absPath);
        console.log(`Deleted: ${absPath}`);
      } else {
        console.error("Specify a path or use --all");
        process.exitCode = 1;
      }
    } catch (err) {
      console.error("Error:", err);
      process.exitCode = 1;
    } finally {
      await closeDatabase();
    }
  });

// ── stats ───────────────────────────────────────────────────────

program
  .command("stats")
  .description("Show graph statistics")
  .argument("[path]", "Filter by repository path")
  .action(async (path?: string) => {
    const db = getDatabase();
    const builder = new GraphBuilder(db);

    try {
      await db.verifyConnectivity();
      const repoPath = path ? resolve(path) : undefined;
      const stats = await builder.getStats(repoPath);
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
      await closeDatabase();
    }
  });

// ── watch ───────────────────────────────────────────────────────

program
  .command("watch")
  .description("Watch a directory for changes and update the graph")
  .argument("[path]", "Directory to watch", ".")
  .action(async (path: string) => {
    const absPath = resolve(path);
    const db = getDatabase();
    const builder = new GraphBuilder(db);
    const watcher = new FileWatcher(builder);

    try {
      await db.verifyConnectivity();
      console.log(`Watching: ${absPath}`);
      console.log("Press Ctrl+C to stop.");
      await watcher.watch(absPath);

      // Keep process alive
      process.on("SIGINT", async () => {
        console.log("\nStopping watcher...");
        await watcher.closeAll();
        await closeDatabase();
        process.exit(0);
      });
    } catch (err) {
      console.error("Error:", err);
      await closeDatabase();
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
    const db = getDatabase();
    try {
      await db.verifyConnectivity();
      const result = await db.runQuery(
        `MATCH (caller:Function)-[r:CALLS]->(callee:Function {name: $name})
         RETURN caller.name as caller, caller.path as path, r.line_number as line`,
        { name: func },
      );
      if (result.records.length === 0) {
        console.log(`No callers found for "${func}".`);
      } else {
        console.log(`Callers of "${func}":`);
        for (const r of result.records) {
          const line = toNum(r.get("line"));
          console.log(`  ${r.get("caller")} (${r.get("path")}:${line})`);
        }
      }
    } catch (err) {
      console.error("Error:", err);
      process.exitCode = 1;
    } finally {
      await closeDatabase();
    }
  });

analyze
  .command("callees")
  .description("Find what a function calls")
  .argument("<func>", "Function name")
  .action(async (func: string) => {
    const db = getDatabase();
    try {
      await db.verifyConnectivity();
      const result = await db.runQuery(
        `MATCH (caller:Function {name: $name})-[r:CALLS]->(callee:Function)
         RETURN callee.name as callee, callee.path as path, r.line_number as line`,
        { name: func },
      );
      if (result.records.length === 0) {
        console.log(`"${func}" doesn't call any tracked functions.`);
      } else {
        console.log(`"${func}" calls:`);
        for (const r of result.records) {
          const line = toNum(r.get("line"));
          console.log(`  ${r.get("callee")} (${r.get("path")}:${line})`);
        }
      }
    } catch (err) {
      console.error("Error:", err);
      process.exitCode = 1;
    } finally {
      await closeDatabase();
    }
  });

analyze
  .command("hierarchy")
  .description("Show class hierarchy")
  .argument("<class>", "Class name")
  .action(async (className: string) => {
    const db = getDatabase();
    try {
      await db.verifyConnectivity();
      const result = await db.runQuery(
        `MATCH path = (c:Class {name: $name})-[:INHERITS*0..10]->(parent:Class)
         RETURN [n in nodes(path) | n.name] as chain`,
        { name: className },
      );
      if (result.records.length === 0) {
        console.log(`No hierarchy found for "${className}".`);
      } else {
        console.log(`Hierarchy for "${className}":`);
        for (const r of result.records) {
          const chain = r.get("chain") as string[];
          console.log(`  ${chain.join(" → ")}`);
        }
      }
    } catch (err) {
      console.error("Error:", err);
      process.exitCode = 1;
    } finally {
      await closeDatabase();
    }
  });

analyze
  .command("dead-code")
  .description("Find functions with no callers")
  .option("-l, --limit <n>", "Max results", "20")
  .action(async (opts: { limit: string }) => {
    const db = getDatabase();
    try {
      await db.verifyConnectivity();
      const result = await db.runQuery(
        `MATCH (f:Function)
         WHERE NOT ()-[:CALLS]->(f)
         RETURN f.name as name, f.path as path, f.line_number as line
         LIMIT $limit`,
        { limit: parseInt(opts.limit, 10) },
      );
      if (result.records.length === 0) {
        console.log("No dead code found.");
      } else {
        console.log("Potentially dead functions:");
        for (const r of result.records) {
          const line = toNum(r.get("line"));
          console.log(`  ${r.get("name")} (${r.get("path")}:${line})`);
        }
      }
    } catch (err) {
      console.error("Error:", err);
      process.exitCode = 1;
    } finally {
      await closeDatabase();
    }
  });

analyze
  .command("complexity")
  .description("Find most complex functions")
  .option("-l, --limit <n>", "Max results", "10")
  .action(async (opts: { limit: string }) => {
    const db = getDatabase();
    try {
      await db.verifyConnectivity();
      const result = await db.runQuery(
        `MATCH (f:Function)
         RETURN f.name as name, f.path as path, f.cyclomatic_complexity as complexity
         ORDER BY f.cyclomatic_complexity DESC
         LIMIT $limit`,
        { limit: parseInt(opts.limit, 10) },
      );
      if (result.records.length === 0) {
        console.log("No functions found.");
      } else {
        console.log("Most complex functions:");
        for (const r of result.records) {
          const complexity = toNum(r.get("complexity"));
          console.log(`  [${complexity}] ${r.get("name")} (${r.get("path")})`);
        }
      }
    } catch (err) {
      console.error("Error:", err);
      process.exitCode = 1;
    } finally {
      await closeDatabase();
    }
  });

// ── mcp ─────────────────────────────────────────────────────────

const mcp = program.command("mcp").description("MCP server commands");

mcp
  .command("start")
  .description("Start the MCP server (stdio transport)")
  .action(async () => {
    try {
      await startMCPServer();
    } catch (err) {
      console.error("MCP server error:", err);
      process.exitCode = 1;
    }
  });

// ── Run ─────────────────────────────────────────────────────────

function toNum(val: unknown): number | string {
  if (val == null) return "?";
  if (typeof val === "number") return val;
  if (typeof (val as any).toNumber === "function") return (val as any).toNumber();
  return String(val);
}

program.parse();
