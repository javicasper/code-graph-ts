import { describe, it, expect, vi, beforeEach } from "vitest";
import { WatchFilesService } from "../../application/watch-files.js";
import type { IndexCode, Logger } from "../../domain/ports.js";

// Mock chokidar
vi.mock("chokidar", () => {
  const mockWatcher = {
    on: vi.fn().mockReturnThis(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    watch: vi.fn(() => mockWatcher),
    __mockWatcher: mockWatcher,
  };
});

describe("WatchFilesService", () => {
  let mockIndexCode: IndexCode;
  let mockLogger: Logger;
  let service: WatchFilesService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIndexCode = {
      indexDirectory: vi.fn(),
      indexFile: vi.fn(),
      removeFile: vi.fn(),
      collectFiles: vi.fn(),
    };
    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    };
    service = new WatchFilesService(mockIndexCode, mockLogger);
  });

  it("should start watching a directory", async () => {
    await service.watch("/my-project");
    expect(service.getWatchedPaths()).toContain("/my-project");
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("Watching"));
  });

  it("should not duplicate watchers for same path", async () => {
    await service.watch("/my-project");
    await service.watch("/my-project");
    expect(service.getWatchedPaths()).toHaveLength(1);
  });

  it("should unwatch a directory", async () => {
    await service.watch("/my-project");
    await service.unwatch("/my-project");
    expect(service.getWatchedPaths()).toHaveLength(0);
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("Unwatched"));
  });

  it("should handle unwatch of non-watched path gracefully", async () => {
    await service.unwatch("/nonexistent");
    expect(service.getWatchedPaths()).toHaveLength(0);
  });

  it("should close all watchers", async () => {
    await service.watch("/project-a");
    await service.watch("/project-b");
    expect(service.getWatchedPaths()).toHaveLength(2);

    await service.closeAll();
    expect(service.getWatchedPaths()).toHaveLength(0);
  });

  it("should track multiple watched paths", async () => {
    await service.watch("/project-a");
    await service.watch("/project-b");
    const paths = service.getWatchedPaths();
    expect(paths).toContain("/project-a");
    expect(paths).toContain("/project-b");
  });
});
