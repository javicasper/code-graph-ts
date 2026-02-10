import type { AppConfig } from "./config.js";
import type {
  GraphRepository,
  IndexCode,
  SearchCode,
  DescribeCode,
  SemanticSearch,
  AnalyzeCode,
  WatchFiles,
  ManageRepositories,
  AskCode,
  JobStore,
  Logger,
} from "./domain/ports.js";
import { Neo4jGraphRepository } from "./infrastructure/neo4j-graph-repository.js";
import { NodeFileSystem } from "./infrastructure/node-filesystem.js";
import { ConsoleLogger } from "./infrastructure/console-logger.js";
import { MultiModelZaiClient } from "./infrastructure/multi-model-zai-client.js";
import { LocalEmbeddingClient } from "./infrastructure/local-embedding.js";
import { JavaScriptParser } from "./domain/parsers/javascript.js";
import { TypeScriptParser } from "./domain/parsers/typescript.js";
import { PHPParser } from "./domain/parsers/php.js";
import { InMemoryJobStore } from "./application/job-store.js";
import { DescribeCodeService } from "./application/describe-code.js";
import { SemanticSearchService } from "./application/semantic-search.js";
import { IndexCodeService } from "./application/index-code.js";
import { SearchCodeService } from "./application/search-code.js";
import { AnalyzeCodeService } from "./application/analyze-code.js";
import { WatchFilesService } from "./application/watch-files.js";
import { ManageRepositoriesService } from "./application/manage-repositories.js";
import { DoctorService } from "./application/doctor.js";
import { AskCodeService } from "./application/ask-code.js";

export interface AppServices {
  graph: GraphRepository;
  indexCode: IndexCode;
  searchCode: SearchCode;
  describeCode: DescribeCode;
  semanticSearch: SemanticSearch;
  analyzeCode: AnalyzeCode;
  watchFiles: WatchFiles;
  manageRepos: ManageRepositories;
  askCode: AskCode;
  doctor: DoctorService;
  jobs: JobStore;
  logger: Logger;
}

export function createAppServices(config: AppConfig): AppServices {
  const logger = new ConsoleLogger();
  const fs = new NodeFileSystem();
  const graph = new Neo4jGraphRepository(
    config.neo4jUri,
    config.neo4jUsername,
    config.neo4jPassword,
  );
  const parsers = [
    new JavaScriptParser(),
    new TypeScriptParser("typescript"),
    new PHPParser(),
  ];
  const jobs = new InMemoryJobStore();

  // New Semantic Search Infrastructure
  // Default to empty/no-op implementations caused problems in previous attempts,
  // so we will instantiate the real clients but they might return null/empty if config is missing.
  // ZaiClient handles missing apiKey gracefully.
  const descriptionGenerator = new MultiModelZaiClient(
    config.zaiApiKey ?? "",
    logger
  );
  const embeddingGenerator = new LocalEmbeddingClient();

  const describeCode = new DescribeCodeService(descriptionGenerator, embeddingGenerator, graph, logger);
  const semanticSearch = new SemanticSearchService(embeddingGenerator, graph);

  // Updated Services with new dependencies
  const indexCode = new IndexCodeService(fs, graph, new TypeScriptParser(), describeCode, jobs, logger);
  const searchCode = new SearchCodeService(graph, logger);
  const analyzeCode = new AnalyzeCodeService(graph);
  const watchFiles = new WatchFilesService(indexCode, describeCode, logger);
  const manageRepos = new ManageRepositoriesService(graph);
  const askCode = new AskCodeService(semanticSearch, graph, descriptionGenerator, logger);
  const doctor = new DoctorService(
    graph,
    descriptionGenerator,
    embeddingGenerator,
    logger,
    { useLocalEmbeddings: config.useLocalEmbeddings ?? false }
  );

  return {
    graph,
    indexCode,
    searchCode,
    describeCode,
    semanticSearch,
    analyzeCode,
    watchFiles,
    manageRepos,
    askCode,
    doctor,
    jobs,
    logger
  };
}
