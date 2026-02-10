
import { bench, describe } from "vitest";
import "dotenv/config";

const API_KEY = process.env.ZAI_API_KEY;
const BASE_URL = "https://api.z.ai/api/anthropic/v1/messages";

const MODELS = [
    "glm-4-plus",
    "glm-4.5",
    "glm-4.7",
    "glm-4.6",
    "glm-4.7-flash",
    "glm-4.7-flashx",
    "glm-4.5-air"
];

const SAMPLE_PROMPT = `
Describe brevísimamente qué hace este código (función/clase) en 1 o 2 frases concisas.
Responde SOLO con la descripción en texto plano.

Archivo: src/example.ts
Símbolo: function calculateSum

Código:
export function calculateSum(a: number, b: number): number {
  return a + b;
}
`.trim();

async function testModel(model: string) {
    if (!API_KEY) throw new Error("ZAI_API_KEY not found");

    const start = Date.now();
    const response = await fetch(BASE_URL, {
        method: "POST",
        headers: {
            "x-api-key": API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        body: JSON.stringify({
            model: model,
            max_tokens: 100,
            messages: [{ role: "user", content: SAMPLE_PROMPT }],
        }),
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Model ${model} failed with status ${response.status}: ${error}`);
    }

    const data = await response.json();
    const latency = Date.now() - start;
    return { model, latency, text: data.content[0].text };
}

describe("Zai Model Latency Benchmark", () => {
    for (const model of MODELS) {
        bench(`Model: ${model}`, async () => {
            await testModel(model);
        }, { iterations: 3 });
    }
});
