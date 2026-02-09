import type { JobStore } from "../domain/ports.js";
import type { IndexJob } from "../domain/types.js";

export class InMemoryJobStore implements JobStore {
  private jobs = new Map<string, IndexJob>();

  create(job: IndexJob): void {
    this.jobs.set(job.id, job);
  }

  get(id: string): IndexJob | undefined {
    return this.jobs.get(id);
  }

  getAll(): IndexJob[] {
    return Array.from(this.jobs.values());
  }

  update(id: string, partial: Partial<IndexJob>): void {
    const job = this.jobs.get(id);
    if (job) {
      Object.assign(job, partial);
    }
  }
}
