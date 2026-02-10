
import type { DescriptionGenerator } from "../domain/ports.js";
import type { Logger } from "../domain/logger.js";

interface ModelConfig {
    name: string;
    limit: number;
}

interface Task {
    prompt: string;
    maxTokens: number;
    resolve: (value: string | null) => void;
    retries: number;
}

export class MultiModelZaiClient implements DescriptionGenerator {
    private readonly baseUrl = "https://api.z.ai/api/anthropic/v1/messages";
    private readonly pool: { name: string; limit: number; active: number }[];
    private readonly queue: Task[] = [];
    private readonly maxRetries = 3;

    constructor(
        private readonly apiKey: string,
        private readonly logger: Logger,
        configs: ModelConfig[] = [
            { name: "glm-4.7", limit: 3 },
            { name: "glm-4.6", limit: 3 },
            { name: "glm-4.5-air", limit: 5 },
            { name: "glm-4.5", limit: 5 }
        ]
    ) {
        this.pool = configs.map(c => ({ ...c, active: 0 }));
    }

    async generateDescription(prompt: string, options?: { maxTokens?: number }): Promise<string | null> {
        if (!this.apiKey) return null;

        return new Promise((resolve) => {
            this.queue.push({ prompt, maxTokens: options?.maxTokens ?? 150, resolve, retries: 0 });
            this.processQueue();
        });
    }

    private async processQueue() {
        if (this.queue.length === 0) return;

        for (const slot of this.pool) {
            if (slot.active < slot.limit) {
                const task = this.queue.shift();
                if (!task) break;

                this.executeTask(task, slot);
            }
        }
    }

    private async executeTask(task: Task, slot: { name: string; limit: number; active: number }) {
        slot.active++;

        try {
            const response = await fetch(this.baseUrl, {
                method: "POST",
                headers: {
                    "x-api-key": this.apiKey,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    model: slot.name,
                    max_tokens: task.maxTokens,
                    messages: [{ role: "user", content: task.prompt }],
                }),
            });

            if (response.ok) {
                const data = await response.json();
                const text = data.content.find((c: any) => c.type === "text")?.text;
                task.resolve(text?.trim() ?? null);
            } else if (response.status === 429 || response.status >= 500) {
                this.handleTaskFailure(task, `API error ${response.status}`);
            } else {
                this.logger.error(`Zai API non-retryable error (${response.status}) with model ${slot.name}`);
                task.resolve(null);
            }
        } catch (error: any) {
            this.handleTaskFailure(task, error.message);
        } finally {
            slot.active--;
            this.processQueue();
        }
    }

    private handleTaskFailure(task: Task, errorMsg: string) {
        if (task.retries < this.maxRetries) {
            task.retries++;
            const delay = Math.pow(2, task.retries) * 1000;
            this.logger.warn(`Retrying task (attempt ${task.retries}) after error: ${errorMsg}. Delay: ${delay}ms`);

            setTimeout(() => {
                this.queue.push(task);
                this.processQueue();
            }, delay);
        } else {
            this.logger.error(`Task failed after ${this.maxRetries} retries: ${errorMsg}`);
            task.resolve(null);
        }
    }
}
