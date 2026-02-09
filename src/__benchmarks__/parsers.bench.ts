import { bench, describe } from "vitest";
import { JavaScriptParser } from "../domain/parsers/javascript.js";
import { TypeScriptParser } from "../domain/parsers/typescript.js";
import { PHPParser } from "../domain/parsers/php.js";

// ── Sample sources ──────────────────────────────────────────────

const JS_SMALL = `
function greet(name) {
  return "Hello, " + name;
}
const add = (a, b) => a + b;
`;

const JS_MEDIUM = `
import { readFile } from 'fs';
import path from 'path';

class Logger {
  constructor(prefix) {
    this.prefix = prefix;
  }
  log(msg) {
    console.log(this.prefix + ": " + msg);
  }
  warn(msg) {
    console.warn(this.prefix + ": " + msg);
  }
}

function processData(items) {
  const results = [];
  for (const item of items) {
    if (item.type === 'a') {
      results.push(handleA(item));
    } else if (item.type === 'b') {
      results.push(handleB(item));
    } else {
      results.push(handleDefault(item));
    }
  }
  return results;
}

function handleA(item) { return { ...item, processed: true }; }
function handleB(item) { return { ...item, processed: true, extra: 'b' }; }
function handleDefault(item) { return item; }

const CONSTANTS = { MAX_RETRIES: 3, TIMEOUT: 5000 };

async function fetchWithRetry(url, retries = CONSTANTS.MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res.json();
    } catch (err) {
      if (i === retries - 1) throw err;
    }
  }
}

class DataService extends Logger {
  constructor() { super('DataService'); }
  async getData(id) {
    this.log('Fetching ' + id);
    return fetchWithRetry('/api/data/' + id);
  }
}

module.exports = { Logger, DataService, processData };
`;

const JS_LARGE = Array(20).fill(JS_MEDIUM).join("\n");

const TS_MEDIUM = `
import { EventEmitter } from 'events';

interface Config {
  host: string;
  port: number;
  debug?: boolean;
}

interface Logger {
  info(msg: string): void;
  error(msg: string, err?: Error): void;
}

type Handler<T> = (data: T) => Promise<void>;

abstract class BaseService {
  protected config: Config;
  constructor(config: Config) {
    this.config = config;
  }
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
}

class HttpService extends BaseService implements Logger {
  private emitter = new EventEmitter();

  info(msg: string): void { console.log(msg); }
  error(msg: string, err?: Error): void { console.error(msg, err); }

  async start(): Promise<void> {
    this.info('Starting on ' + this.config.host + ':' + this.config.port);
    this.emitter.emit('start');
  }

  async stop(): Promise<void> {
    this.info('Stopping');
    this.emitter.emit('stop');
  }

  on<T>(event: string, handler: Handler<T>): void {
    this.emitter.on(event, handler);
  }
}

function createService(config: Config): BaseService {
  return new HttpService(config);
}

export { Config, Logger, BaseService, HttpService, createService };
`;

const PHP_MEDIUM = `<?php
namespace App\\Services;

use App\\Models\\User;
use App\\Contracts\\Repository;

interface UserRepository extends Repository {
    public function findById(int $id): ?User;
    public function findByEmail(string $email): ?User;
}

abstract class BaseService {
    protected $logger;
    public function __construct($logger) {
        $this->logger = $logger;
    }
    abstract protected function validate($data): bool;
}

class UserService extends BaseService {
    private UserRepository $repo;

    public function __construct($logger, UserRepository $repo) {
        parent::__construct($logger);
        $this->repo = $repo;
    }

    protected function validate($data): bool {
        return isset($data['name']) && isset($data['email']);
    }

    public function getUser(int $id): ?User {
        $this->logger->info("Fetching user {$id}");
        return $this->repo->findById($id);
    }

    public function getUserByEmail(string $email): ?User {
        if (empty($email)) {
            throw new \\InvalidArgumentException('Email required');
        }
        return $this->repo->findByEmail($email);
    }

    public static function formatName(string $first, string $last): string {
        return trim($first) . ' ' . trim($last);
    }
}

function helperFunction($value) {
    return is_string($value) ? trim($value) : $value;
}
`;

// ── Parsers ─────────────────────────────────────────────────────

const jsParser = new JavaScriptParser();
const tsParser = new TypeScriptParser("typescript");
const phpParser = new PHPParser();

// ── Benchmarks ──────────────────────────────────────────────────

describe("JavaScript Parser", () => {
  bench("parse small (~5 lines)", () => {
    jsParser.parse(JS_SMALL, "/bench/small.js");
  });

  bench("parse medium (~65 lines)", () => {
    jsParser.parse(JS_MEDIUM, "/bench/medium.js");
  });

  bench("parse large (~1300 lines)", () => {
    jsParser.parse(JS_LARGE, "/bench/large.js");
  });

  bench("preScan 10 files", () => {
    const files = Array.from({ length: 10 }, (_, i) => ({
      filePath: `/bench/file${i}.js`,
      sourceCode: JS_MEDIUM,
    }));
    jsParser.preScan(files);
  });
});

describe("TypeScript Parser", () => {
  bench("parse medium (~55 lines)", () => {
    tsParser.parse(TS_MEDIUM, "/bench/medium.ts");
  });

  bench("preScan 10 files", () => {
    const files = Array.from({ length: 10 }, (_, i) => ({
      filePath: `/bench/file${i}.ts`,
      sourceCode: TS_MEDIUM,
    }));
    tsParser.preScan(files);
  });
});

describe("PHP Parser", () => {
  bench("parse medium (~60 lines)", () => {
    phpParser.parse(PHP_MEDIUM, "/bench/medium.php");
  });

  bench("preScan 10 files", () => {
    const files = Array.from({ length: 10 }, (_, i) => ({
      filePath: `/bench/file${i}.php`,
      sourceCode: PHP_MEDIUM,
    }));
    phpParser.preScan(files);
  });
});

describe("Symbol Resolution", async () => {
  const { resolveSymbol } = await import("../domain/symbol-resolver.js");
  const parsed = jsParser.parse(JS_MEDIUM, "/bench/medium.js");
  const importsMap = new Map([
    ["readFile", [{ filePath: "/node_modules/fs.js", lineNumber: 1 }]],
    ["Logger", [{ filePath: "/bench/medium.js", lineNumber: 5 }]],
    ["DataService", [{ filePath: "/bench/medium.js", lineNumber: 30 }]],
    ["unknownSymbol", [{ filePath: "/other/file.js", lineNumber: 1 }]],
  ]);

  bench("resolveSymbol (imported)", () => {
    resolveSymbol("readFile", parsed, importsMap);
  });

  bench("resolveSymbol (local)", () => {
    resolveSymbol("Logger", parsed, importsMap);
  });

  bench("resolveSymbol (miss)", () => {
    resolveSymbol("nonexistent", parsed, importsMap);
  });
});
