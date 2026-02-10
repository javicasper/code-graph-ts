
import type { DescriptionGenerator } from "../domain/ports.js";

interface AnthropicMessage {
    role: "user" | "assistant";
    content: string;
}

interface AnthropicResponse {
    id: string;
    type: "message";
    role: "assistant";
    content: { type: "text"; text: string }[];
    model: string;
    stop_reason: string | null;
    usage: {
        input_tokens: number;
        output_tokens: number;
    };
}

export class ZaiClient implements DescriptionGenerator {
    constructor(
        private readonly apiKey: string,
        private readonly baseUrl = "https://api.z.ai/api/anthropic/v1/messages",
        private readonly model = "glm-4.7",
    ) { }

    async generateDescription(prompt: string): Promise<string | null> {
        if (!this.apiKey) return null;

        try {
            const response = await fetch(this.baseUrl, {
                method: "POST",
                headers: {
                    "x-api-key": this.apiKey,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    model: this.model,
                    max_tokens: 150, // Keep descriptions concise
                    messages: [
                        {
                            role: "user",
                            content: prompt,
                        },
                    ] as AnthropicMessage[],
                }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`Z.ai API error (${response.status}): ${errorText}`);
                return null;
            }

            const data = (await response.json()) as AnthropicResponse;
            const text = data.content.find((c) => c.type === "text")?.text;
            return text?.trim() ?? null;
        } catch (error) {
            console.error("Error generating description with Z.ai:", error);
            return null;
        }
    }
}
