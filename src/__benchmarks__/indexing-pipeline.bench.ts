import { bench, describe } from "vitest";
import { IndexCodeService } from "../application/index-code.js";
import { InMemoryJobStore } from "../application/job-store.js";
import { JavaScriptParser } from "../domain/parsers/javascript.js";
import type { GraphRepository, FileSystem, Logger } from "../domain/ports.js";

// ── Sample source code ──────────────────────────────────────────

const JS_MEDIUM = `
import { readFile } from 'fs';
import path from 'path';

class Logger {
  constructor(prefix) { this.prefix = prefix; }
  log(msg) { console.log(this.prefix + ": " + msg); }
  warn(msg) { console.warn(this.prefix + ": " + msg); }
}

function processData(items) {
  const results = [];
  for (const item of items) {
    if (item.type === 'a') results.push(handleA(item));
    else results.push(handleDefault(item));
  }
  return results;
}

function handleA(item) { return { ...item, processed: true }; }
function handleDefault(item) { return item; }

const TIMEOUT = 5000;

async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { return await fetch(url); } catch (err) { if (i === retries - 1) throw err; }
  }
}

class DataService extends Logger {
  constructor() { super('DataService'); }
  async getData(id) { return fetchWithRetry('/api/' + id); }
}

module.exports = { Logger, DataService, processData };
`;

// ── Mock infrastructure ─────────────────────────────────────────

let sessionCount = 0;

function createCountingGraph(): GraphRepository {
  return {
    verifyConnectivity: async () => {},
    ensureSchema: async () => {},
    runQuery: async () => { sessionCount++; return []; },
    mergeNode: async () => { sessionCount++; },
    mergeRelationship: async () => { sessionCount++; },
    deleteFileNodes: async () => { sessionCount++; },
    deleteRepository: async () => {},
    deleteAll: async () => {},
    close: async () => {},
    executeBatch: async (fn) => {
      sessionCount++; // 1 session for the entire batch
      await fn();
    },
  };
}

function createMockFs(): FileSystem {
  return {
    readFile: async () => JS_MEDIUM,
    exists: () => false,
    glob: async () => ["/project/src/index.js"],
  };
}

const noopLogger: Logger = {
  info: () => {},
  error: () => {},
  warn: () => {},
};

// ── Benchmarks ──────────────────────────────────────────────────

describe("Indexing Pipeline", () => {
  const parser = new JavaScriptParser();

  bench("indexFile (single file, mock graph)", async () => {
    const graph = createCountingGraph();
    const service = new IndexCodeService(graph, createMockFs(), [parser], new InMemoryJobStore(), noopLogger);
    await service.indexFile("/project/src/index.js", "/project", new Map());
  });

  bench("indexDirectory (1 file, full pipeline)", async () => {
    const graph = createCountingGraph();
    const service = new IndexCodeService(graph, createMockFs(), [parser], new InMemoryJobStore(), noopLogger);
    await service.indexDirectory("/project");
  });

  bench("parse only (no graph, baseline)", () => {
    parser.parse(JS_MEDIUM, "/project/src/index.js");
  });
});

describe("Session count measurement", () => {
  const parser = new JavaScriptParser();

  bench("count graph operations per indexFile", async () => {
    sessionCount = 0;
    const graph = createCountingGraph();
    const service = new IndexCodeService(graph, createMockFs(), [parser], new InMemoryJobStore(), noopLogger);
    await service.indexFile("/project/src/index.js", "/project", new Map());
    // With executeBatch: sessionCount should be ~1 (the batch) + inner calls
    // Without: would be ~40+ individual sessions
  });
});
