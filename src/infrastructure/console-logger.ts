import type { Logger } from "../domain/ports.js";

export class ConsoleLogger implements Logger {
  info(msg: string, ...args: unknown[]): void {
    console.error(`[INFO] ${msg}`, ...args);
  }

  error(msg: string, ...args: unknown[]): void {
    console.error(`[ERROR] ${msg}`, ...args);
  }

  warn(msg: string, ...args: unknown[]): void {
    console.error(`[WARN] ${msg}`, ...args);
  }
}
