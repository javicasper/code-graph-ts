import { readFileSync, existsSync } from "node:fs";
import { globby } from "globby";
import type { FileSystem, GlobOptions } from "../domain/ports.js";

export class NodeFileSystem implements FileSystem {
  readFile(filePath: string): string {
    return readFileSync(filePath, "utf-8");
  }

  exists(filePath: string): boolean {
    return existsSync(filePath);
  }

  async glob(patterns: string[], options: GlobOptions): Promise<string[]> {
    return globby(patterns, {
      cwd: options.cwd,
      absolute: options.absolute ?? true,
      ignore: options.ignore,
    });
  }
}
