
import type { SemanticSearch, EmbeddingGenerator, GraphReader } from "../domain/ports.js";
import type { SemanticSearchResult } from "../domain/types.js";

export class SemanticSearchService implements SemanticSearch {
    constructor(
        private readonly embedder: EmbeddingGenerator,
        private readonly graph: GraphReader,
    ) { }

    async search(query: string, limit: number): Promise<SemanticSearchResult[]> {
        // 1. Generate embedding for the query
        const embedding = await this.embedder.generateEmbedding(query);

        if (embedding.length === 0) {
            return [];
        }

        // 2. Perform vector search in Neo4j
        return this.graph.vectorSearch(embedding, limit);
    }
}
