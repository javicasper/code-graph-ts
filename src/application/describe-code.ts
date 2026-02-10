
import crypto from "node:crypto";
import type { DescribeCode, DescriptionGenerator, EmbeddingGenerator, GraphRepository } from "../domain/ports.js";
import type { ParsedFile, SymbolSummary } from "../domain/types.js";
import type { Logger } from "../domain/logger.js";

export class DescribeCodeService implements DescribeCode {
    constructor(
        private readonly describer: DescriptionGenerator,
        private readonly embedder: EmbeddingGenerator,
        private readonly graph: GraphRepository,
        private readonly logger: Logger,
    ) { }

    async describeFile(parsedFile: ParsedFile): Promise<SymbolSummary[]> {
        const results: SymbolSummary[] = [];

        // Process functions
        for (const func of parsedFile.functions) {
            if (!func.source) continue;
            const summary = await this.processSymbol("function", func.name, func.source, parsedFile.path, func.lineNumber);
            if (summary) results.push(summary);
        }

        // Process classes
        for (const cls of parsedFile.classes) {
            if (!cls.source) continue;
            const summary = await this.processSymbol("class", cls.name, cls.source, parsedFile.path, cls.lineNumber);
            if (summary) results.push(summary);
        }

        // Process variables (optional, maybe skip simple ones?)
        // for (const variable of parsedFile.variables) { ... }

        return results;
    }

    private async processSymbol(
        kind: "function" | "class" | "variable",
        name: string,
        source: string,
        filePath: string,
        lineNumber: number,
    ): Promise<SymbolSummary | null> {
        try {
            const contentHash = this.computeHash(source);

            // Check if hash changed (optimization)
            // Note: We need to implement getContentHash in GraphReader first.
            // For now, we might just overwrite or rely on Neo4j merge, but to save API calls
            // we should check the hash.
            const storedHash = await this.graph.getContentHash(kind === "function" ? "Function" : "Class", { path: filePath, name });

            if (storedHash === contentHash) {
                this.logger.debug(`Skipping description for ${name} (unchanged)`);
                return null; // Already up to date
            }

            this.logger.info(`Generating description for ${kind} ${name}...`);

            // 1. Generate Description
            const prompt = this.buildPrompt(kind, name, filePath, source);
            const description = await this.describer.generateDescription(prompt);

            if (!description) {
                this.logger.warn(`Failed to generate description for ${name}`);
                return null;
            }

            // 2. Generate Embedding
            const embedding = await this.embedder.generateEmbedding(description);

            // 3. Save to Neo4j
            await this.graph.setNodeEmbedding(
                kind === "function" ? "Function" : "Class",
                { path: filePath, name },
                embedding,
                description,
                contentHash
            );

            return {
                name,
                kind,
                path: filePath,
                lineNumber,
                description,
                contentHash,
            };

        } catch (error) {
            this.logger.error(`Error describing ${name}:`, error);
            return null;
        }
    }

    private computeHash(content: string): string {
        return crypto.createHash("sha256").update(content).digest("hex");
    }

    private buildPrompt(kind: string, name: string, path: string, source: string): string {
        return `
Describe brevísimamente qué hace este código (función/clase) en 1 o 2 frases concisas.
Responde SOLO con la descripción en texto plano, sin markdown, sin introducción ("Esta función hace...").
Céntrate en la intención y lógica de negocio, no en detalles sintácticos.

Archivo: ${path}
Símbolo: ${kind} ${name}

Código:
${source.slice(0, 2000)} // Truncate if too long to avoid token limits
`.trim();
    }
}
