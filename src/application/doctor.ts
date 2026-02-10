import type { GraphRepository, DescriptionGenerator, EmbeddingGenerator } from "../domain/ports.js";
import type { Logger } from "../domain/logger.js";

export interface HealthCheckResult {
    component: string;
    status: "ok" | "error" | "skipped";
    message?: string;
    latencyMs?: number;
}

export class DoctorService {
    constructor(
        private readonly graph: GraphRepository,
        private readonly describer: DescriptionGenerator,
        private readonly embedder: EmbeddingGenerator,
        private readonly logger: Logger,
        private readonly config: { useLocalEmbeddings: boolean }
    ) { }

    async checkHealth(): Promise<HealthCheckResult[]> {
        const results: HealthCheckResult[] = [];

        // 1. Check Neo4j
        results.push(await this.checkNeo4j());

        // 2. Check Zai API
        results.push(await this.checkZai());

        // 3. Check Embeddings
        results.push(await this.checkEmbeddings());

        return results;
    }

    private async checkNeo4j(): Promise<HealthCheckResult> {
        const start = Date.now();
        try {
            await this.graph.verifyConnectivity();
            // Optional: run a simple query to be sure
            await this.graph.runQuery("RETURN 1");
            return { component: "Neo4j Database", status: "ok", latencyMs: Date.now() - start };
        } catch (error) {
            return {
                component: "Neo4j Database",
                status: "error",
                message: error instanceof Error ? error.message : String(error)
            };
        }
    }

    private async checkZai(): Promise<HealthCheckResult> {
        const start = Date.now();
        try {
            // We'll try to generate a very short description for a test string
            const testPrompt = "Describe this code: function hello() { console.log('hi'); }";
            await this.describer.generateDescription(testPrompt);
            return { component: "Zai API (LLM)", status: "ok", latencyMs: Date.now() - start };
        } catch (error) {
            return {
                component: "Zai API (LLM)",
                status: "error",
                message: error instanceof Error ? error.message : String(error)
            };
        }
    }

    private async checkEmbeddings(): Promise<HealthCheckResult> {
        const start = Date.now();
        try {
            const type = this.config.useLocalEmbeddings ? "Local (Transformer)" : "Remote (API)";
            await this.embedder.generateEmbedding("check health");
            return { component: `Embeddings (${type})`, status: "ok", latencyMs: Date.now() - start };
        } catch (error) {
            return {
                component: "Embeddings",
                status: "error",
                message: error instanceof Error ? error.message : String(error)
            };
        }
    }
}
