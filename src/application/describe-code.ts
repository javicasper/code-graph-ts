import { basename, relative, resolve } from "node:path";
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

    async describeFile(parsedFile: ParsedFile, previousHashes?: Record<string, string>): Promise<SymbolSummary[]> {
        const symbolPromises: Promise<SymbolSummary | null>[] = [];
        // 1. Queue Symbols (Functions, Classes)
        for (const func of parsedFile.functions) {
            if (!func.source) continue;
            symbolPromises.push(this.processSymbol("function", func.name, func.source, parsedFile.path, func.lineNumber, previousHashes));
        }

        for (const cls of parsedFile.classes) {
            if (!cls.source) continue;
            symbolPromises.push(this.processSymbol("class", cls.name, cls.source, parsedFile.path, cls.lineNumber, previousHashes));
        }

        // 2. Wait for all symbols and process File itself
        const results = (await Promise.all(symbolPromises)).filter((s): s is SymbolSummary => s !== null);
        await this.processFile(parsedFile);

        return results;
    }

    async describeDirectory(repoPath: string, dirPath: string, files: string[]): Promise<void> {
        try {
            const dirName = basename(dirPath);
            const relPath = relative(repoPath, dirPath);
            const fileList = files.map(f => basename(f)).join(", ");
            const contentHash = this.computeHash(fileList);

            const storedHash = await this.graph.getContentHash("Directory", { path: dirPath });
            if (storedHash === contentHash) {
                this.logger.debug(`Skipping description for directory ${relPath} (unchanged)`);
                return;
            }

            this.logger.info(`Generating description for directory ${relPath}...`);
            // ... prompt ...

            const prompt = `
Describe brevísimamente el propósito de este directorio en 1 o 2 frases concisas.
Básate en su nombre y en la lista de archivos que contiene.
Responde SOLO con la descripción en texto plano.

Directorio: ${relPath}
Archivos: ${fileList}
`.trim();

            const description = await this.describer.generateDescription(prompt);
            if (!description) return;

            this.logger.info(`   > Directory Desc: ${description}`);
            const embedding = await this.embedder.generateEmbedding(description);

            await this.graph.setNodeEmbedding(
                "Directory",
                { path: dirPath },
                embedding,
                description,
                this.computeHash(fileList) // Hash of file names to detect changes
            );
        } catch (error) {
            this.logger.error(`Error describing directory ${dirPath}:`, error);
        }
    }

    private async processFile(parsedFile: ParsedFile): Promise<void> {
        try {
            const sourceCode = parsedFile.source || "";
            const contentHash = this.computeHash(sourceCode);
            const storedHash = await this.graph.getContentHash("File", { path: parsedFile.path });

            if (storedHash === contentHash) return;

            this.logger.info(`Generating description for file ${basename(parsedFile.path)}...`);

            const symbols = [
                ...parsedFile.classes.map(c => `Clase: ${c.name}`),
                ...parsedFile.functions.map(f => `Función: ${f.name}`)
            ].join(", ");

            const prompt = `
Describe brevísimamente qué hace este archivo en 1 o 2 frases concisas.
Ten en cuenta los símbolos que contiene: ${symbols}
Responde SOLO con la descripción en texto plano.

Archivo: ${parsedFile.path}
Código (primeros 2000 chars):
${sourceCode.slice(0, 2000)}
`.trim();

            const description = await this.describer.generateDescription(prompt);
            if (!description) return;

            this.logger.info(`   > File Desc: ${description}`);
            const embedding = await this.embedder.generateEmbedding(description);

            await this.graph.setNodeEmbedding(
                "File",
                { path: parsedFile.path },
                embedding,
                description,
                contentHash
            );
        } catch (error) {
            this.logger.error(`Error describing file ${parsedFile.path}:`, error);
        }
    }

    private async processSymbol(
        kind: "function" | "class" | "variable",
        name: string,
        source: string,
        filePath: string,
        lineNumber: number,
        previousHashes?: Record<string, string>,
    ): Promise<SymbolSummary | null> {
        try {
            const contentHash = this.computeHash(source);
            const label = kind === "function" ? "Function" : kind === "class" ? "Class" : "Variable";

            // Check provided previousHashes first (more reliable during re-indexing)
            let storedHash = previousHashes?.[name];

            // If not provided, fallback to checking the graph directly
            if (storedHash === undefined) {
                storedHash = await this.graph.getContentHash(label, { path: filePath, name }) ?? undefined;
            }

            if (storedHash === contentHash) {
                this.logger.debug(`Skipping description for ${name} (unchanged)`);
                return null;
            }

            this.logger.info(`Generating description for ${kind} ${name}...`);

            const prompt = this.buildPrompt(kind, name, filePath, source);
            const description = await this.describer.generateDescription(prompt);

            if (!description) {
                this.logger.warn(`Failed to generate description for ${name}`);
                return null;
            }

            this.logger.info(`   > Symbol Desc: ${description}`);
            const embedding = await this.embedder.generateEmbedding(description);

            await this.graph.setNodeEmbedding(
                label,
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
${source.slice(0, 2000)}
`.trim();
    }
}
