import type { Logger } from "../domain/ports.js";

export class ConsoleLogger implements Logger {
  info(msg: string, ...args: unknown[]): void {
    console.log(`[INFO] ${msg}`, ...args);
  }

  debug(msg: string, ...args: unknown[]): void {
    console.debug(`[DEBUG] ${msg}`, ...args);
  }

  error(msg: string, ...args: unknown[]): void {
    console.error(`[ERROR] ${msg}`, ...args);
  }

  warn(msg: string, ...args: unknown[]): void {
    console.warn(`[WARN] ${msg}`, ...args);
  }
}
