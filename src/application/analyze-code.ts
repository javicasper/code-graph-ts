import type { AnalyzeCode, GraphReader } from "../domain/ports.js";
import type {
  CallerResult,
  CalleeResult,
  DeadCodeResult,
  ImporterResult,
  ComplexityResult,
} from "../domain/types.js";
import { toNumber } from "../domain/neo4j-helpers.js";

export class AnalyzeCodeService implements AnalyzeCode {
  constructor(private readonly graph: GraphReader) {}

  async findCallers(name: string, limit: number): Promise<CallerResult[]> {
    const rows = await this.graph.runQuery(
      `MATCH (caller:Function)-[r:CALLS]->(callee:Function {name: $name})
       RETURN caller.name as caller_name, caller.path as caller_path,
              caller.line_number as caller_line, r.line_number as call_line
       LIMIT toInteger($limit)`,
      { name, limit },
    );
    return rows.map((r) => ({
      callerName: r.caller_name as string,
      callerPath: r.caller_path as string,
      callerLine: toNumber(r.caller_line),
      callLine: toNumber(r.call_line),
    }));
  }

  async findCallees(name: string, limit: number): Promise<CalleeResult[]> {
    const rows = await this.graph.runQuery(
      `MATCH (caller:Function {name: $name})-[r:CALLS]->(callee:Function)
       RETURN callee.name as callee_name, callee.path as callee_path,
              callee.line_number as callee_line, r.line_number as call_line
       LIMIT toInteger($limit)`,
      { name, limit },
    );
    return rows.map((r) => ({
      calleeName: r.callee_name as string,
      calleePath: r.callee_path as string,
      calleeLine: toNumber(r.callee_line),
      callLine: toNumber(r.call_line),
    }));
  }

  async classHierarchy(name: string, depth: number): Promise<string[][]> {
    const rows = await this.graph.runQuery(
      `MATCH path = (c:Class {name: $name})-[:INHERITS*0..${depth}]->(parent:Class)
       RETURN [n in nodes(path) | n.name] as hierarchy`,
      { name },
    );
    return rows.map((r) => r.hierarchy as string[]);
  }

  async deadCode(limit: number, repoPath?: string): Promise<DeadCodeResult[]> {
    const where = repoPath ? "AND f.repo_path = $repoPath" : "";
    const rows = await this.graph.runQuery(
      `MATCH (f:Function)
       WHERE NOT ()-[:CALLS]->(f) ${where}
         AND (f.kind IS NULL OR f.kind <> 'constructor')
       RETURN f.name as name, f.path as path, f.line_number as line_number
       LIMIT toInteger($limit)`,
      { limit, repoPath },
    );
    return rows.map((r) => ({
      name: r.name as string,
      path: r.path as string,
      lineNumber: toNumber(r.line_number),
    }));
  }

  async callChain(name: string, depth: number, limit: number): Promise<string[][]> {
    const rows = await this.graph.runQuery(
      `MATCH path = (start:Function {name: $name})-[:CALLS*1..${depth}]->(end:Function)
       RETURN [n in nodes(path) | n.name] as chain
       LIMIT toInteger($limit)`,
      { name, limit },
    );
    return rows.map((r) => r.chain as string[]);
  }

  async findImporters(name: string, limit: number): Promise<ImporterResult[]> {
    const rows = await this.graph.runQuery(
      `MATCH (f:File)-[r:IMPORTS]->(m:Module)
       WHERE r.imported_name = $name OR m.name CONTAINS $name
       RETURN f.path as file_path, m.name as module, r.imported_name as imported_name
       LIMIT toInteger($limit)`,
      { name, limit },
    );
    return rows.map((r) => ({
      filePath: r.file_path as string,
      module: r.module as string,
      importedName: r.imported_name as string,
    }));
  }

  async moduleDeps(name: string, limit: number): Promise<string[]> {
    const rows = await this.graph.runQuery(
      `MATCH (f:File)-[:IMPORTS]->(m:Module)
       WHERE f.path CONTAINS $name OR f.name = $name
       RETURN DISTINCT m.name as module
       LIMIT toInteger($limit)`,
      { name, limit },
    );
    return rows.map((r) => r.module as string);
  }

  async findComplexity(name: string, limit: number): Promise<ComplexityResult[]> {
    const rows = await this.graph.runQuery(
      `MATCH (f:Function)
       WHERE f.name CONTAINS $name
       RETURN f.name as name, f.path as path, f.cyclomatic_complexity as complexity
       ORDER BY f.cyclomatic_complexity DESC
       LIMIT toInteger($limit)`,
      { name, limit },
    );
    return rows.map((r) => ({
      name: r.name as string,
      path: r.path as string,
      complexity: toNumber(r.complexity),
    }));
  }

  async mostComplexFunctions(limit: number, repoPath?: string): Promise<ComplexityResult[]> {
    const where = repoPath ? "WHERE f.repo_path = $repoPath" : "";
    const rows = await this.graph.runQuery(
      `MATCH (f:Function) ${where}
       RETURN f.name as name, f.path as path, f.line_number as line_number,
              f.cyclomatic_complexity as complexity
       ORDER BY f.cyclomatic_complexity DESC LIMIT toInteger($limit)`,
      { limit, repoPath },
    );
    return rows.map((r) => ({
      name: r.name as string,
      path: r.path as string,
      lineNumber: toNumber(r.line_number),
      complexity: toNumber(r.complexity),
    }));
  }

  async calculateComplexity(name: string, path?: string): Promise<ComplexityResult[]> {
    const where = path
      ? "WHERE f.name = $name AND f.path = $path"
      : "WHERE f.name = $name";
    const rows = await this.graph.runQuery(
      `MATCH (f:Function) ${where}
       RETURN f.name as name, f.path as path, f.line_number as line_number,
              f.cyclomatic_complexity as complexity`,
      { name, path },
    );
    return rows.map((r) => ({
      name: r.name as string,
      path: r.path as string,
      lineNumber: toNumber(r.line_number),
      complexity: toNumber(r.complexity),
    }));
  }
}
