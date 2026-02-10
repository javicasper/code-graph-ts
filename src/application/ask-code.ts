import type {
  AskCode,
  SemanticSearch,
  GraphReader,
  DescriptionGenerator,
  Logger,
} from "../domain/ports.js";
import type { AskResult, SemanticSearchResult } from "../domain/types.js";

interface EnrichedSymbol {
  name: string;
  kind: string;
  path: string;
  lineNumber?: number;
  description: string;
  score: number;
  source?: string;
  callers?: string[];
  callees?: string[];
  parents?: string[];
  interfaces?: string[];
}

export class AskCodeService implements AskCode {
  constructor(
    private readonly semanticSearch: SemanticSearch,
    private readonly graph: GraphReader,
    private readonly llm: DescriptionGenerator,
    private readonly logger: Logger,
  ) {}

  async ask(
    question: string,
    options?: { limit?: number; repoPath?: string },
  ): Promise<AskResult> {
    const limit = options?.limit ?? 12;

    // 1. Semantic search for relevant symbols
    this.logger.debug(`[ask] Searching for symbols related to: "${question}"`);
    const results = await this.semanticSearch.search(question, limit);

    if (results.length === 0) {
      return {
        answer: "No encontré símbolos relevantes en el código indexado para responder esta pregunta.",
        sources: [],
      };
    }

    // 2. Enrich top results with graph context
    const enriched = await this.enrichWithGraph(results);

    // 3. Build prompt and call LLM
    const prompt = this.buildPrompt(question, enriched);
    this.logger.debug(`[ask] Sending prompt to LLM (${prompt.length} chars)`);
    const answer = await this.llm.generateDescription(prompt, { maxTokens: 1500 });

    return {
      answer: answer ?? "No pude generar una respuesta.",
      sources: results.map((r) => ({
        name: r.name,
        kind: r.kind,
        path: r.path,
        lineNumber: r.lineNumber,
        score: r.score,
      })),
    };
  }

  private async enrichWithGraph(
    results: SemanticSearchResult[],
  ): Promise<EnrichedSymbol[]> {
    const enriched: EnrichedSymbol[] = [];

    for (const r of results) {
      const symbol: EnrichedSymbol = {
        name: r.name,
        kind: r.kind,
        path: r.path,
        lineNumber: r.lineNumber,
        description: r.description,
        score: r.score,
      };

      try {
        if (r.kind === "function") {
          const rows = await this.graph.runQuery(
            `MATCH (f:Function {name: $name, path: $path})
             OPTIONAL MATCH (f)-[:CALLS]->(callee:Function)
             WITH f, collect(DISTINCT callee.name)[..5] AS callees
             OPTIONAL MATCH (caller:Function)-[:CALLS]->(f)
             RETURN f.source AS source, callees, collect(DISTINCT caller.name)[..5] AS callers`,
            { name: r.name, path: r.path },
          );
          if (rows.length > 0) {
            const row = rows[0];
            symbol.source = truncateSource(row.source as string | undefined);
            symbol.callees = row.callees as string[];
            symbol.callers = row.callers as string[];
          }
        } else if (r.kind === "class") {
          const rows = await this.graph.runQuery(
            `MATCH (c:Class {name: $name, path: $path})
             OPTIONAL MATCH (c)-[:INHERITS]->(parent:Class)
             OPTIONAL MATCH (c)-[:IMPLEMENTS]->(iface:Class)
             RETURN c.source AS source, collect(DISTINCT parent.name) AS parents, collect(DISTINCT iface.name) AS interfaces`,
            { name: r.name, path: r.path },
          );
          if (rows.length > 0) {
            const row = rows[0];
            symbol.source = truncateSource(row.source as string | undefined);
            symbol.parents = row.parents as string[];
            symbol.interfaces = row.interfaces as string[];
          }
        } else {
          // variable or other
          const rows = await this.graph.runQuery(
            `MATCH (v {name: $name, path: $path}) WHERE v:Variable OR v:Function OR v:Class
             RETURN v.source AS source LIMIT 1`,
            { name: r.name, path: r.path },
          );
          if (rows.length > 0) {
            symbol.source = truncateSource(rows[0].source as string | undefined);
          }
        }
      } catch (err) {
        this.logger.debug(`[ask] Failed to enrich ${r.kind} ${r.name}: ${err}`);
      }

      enriched.push(symbol);
    }

    return enriched;
  }

  private buildPrompt(question: string, symbols: EnrichedSymbol[]): string {
    const contextBlocks = symbols.map((s) => {
      const lines: string[] = [];
      lines.push(`### ${s.kind} \`${s.name}\` — ${s.path}:${s.lineNumber ?? "?"}`);
      lines.push(`Description: ${s.description}`);

      if (s.callers?.length) lines.push(`Called by: ${s.callers.join(", ")}`);
      if (s.callees?.length) lines.push(`Calls: ${s.callees.join(", ")}`);
      if (s.parents?.length) lines.push(`Extends: ${s.parents.join(", ")}`);
      if (s.interfaces?.length) lines.push(`Implements: ${s.interfaces.join(", ")}`);

      if (s.source) {
        lines.push("```");
        lines.push(s.source);
        lines.push("```");
      }

      return lines.join("\n");
    });

    return `You are an expert code assistant. Answer based ONLY on the provided context.

Rules:
- If there is no evidence, say "No encontré evidencia de esto en el código indexado."
- Cite file paths and symbols (file:line)
- Do not invent code that is not in the context
- Answer in the same language as the question

## Context

${contextBlocks.join("\n\n")}

## Question

${question}`;
  }
}

function truncateSource(source: string | undefined | null): string | undefined {
  if (!source) return undefined;
  if (source.length <= 1500) return source;
  return source.slice(0, 1500) + "\n// ... truncated";
}
