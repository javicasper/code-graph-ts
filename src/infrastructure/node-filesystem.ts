import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import fg from "fast-glob";
import type { FileSystem, GlobOptions } from "../domain/ports.js";

export class NodeFileSystem implements FileSystem {
  async readFile(filePath: string): Promise<string> {
    return readFile(filePath, "utf-8");
  }

  exists(filePath: string): boolean {
    return existsSync(filePath);
  }

  async glob(patterns: string[], options: GlobOptions): Promise<string[]> {
    return fg(patterns, {
      cwd: options.cwd,
      absolute: options.absolute ?? true,
      ignore: options.ignore,
    });
  }
}
