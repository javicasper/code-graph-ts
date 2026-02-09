import type { AppConfig } from "./config.js";
import type {
  GraphRepository,
  IndexCode,
  SearchCode,
  AnalyzeCode,
  WatchFiles,
  ManageRepositories,
  JobStore,
  Logger,
} from "./domain/ports.js";
import { Neo4jGraphRepository } from "./infrastructure/neo4j-graph-repository.js";
import { NodeFileSystem } from "./infrastructure/node-filesystem.js";
import { ConsoleLogger } from "./infrastructure/console-logger.js";
import { JavaScriptParser } from "./domain/parsers/javascript.js";
import { TypeScriptParser } from "./domain/parsers/typescript.js";
import { PHPParser } from "./domain/parsers/php.js";
import { InMemoryJobStore } from "./application/job-store.js";
import { IndexCodeService } from "./application/index-code.js";
import { SearchCodeService } from "./application/search-code.js";
import { AnalyzeCodeService } from "./application/analyze-code.js";
import { WatchFilesService } from "./application/watch-files.js";
import { ManageRepositoriesService } from "./application/manage-repositories.js";

export interface AppServices {
  graph: GraphRepository;
  indexCode: IndexCode;
  searchCode: SearchCode;
  analyzeCode: AnalyzeCode;
  watchFiles: WatchFiles;
  manageRepos: ManageRepositories;
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
  const indexCode = new IndexCodeService(graph, fs, parsers, jobs, logger);
  const searchCode = new SearchCodeService(graph);
  const analyzeCode = new AnalyzeCodeService(graph);
  const watchFiles = new WatchFilesService(indexCode, logger);
  const manageRepos = new ManageRepositoriesService(graph);

  return { graph, indexCode, searchCode, analyzeCode, watchFiles, manageRepos, jobs, logger };
}
