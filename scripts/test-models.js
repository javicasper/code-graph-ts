
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

const SAMPLE_PROMPT = "Di 'hola' y nada más.";

async function testModel(model) {
    if (!API_KEY) throw new Error("ZAI_API_KEY not found in .env");

    const start = Date.now();
    try {
        const response = await fetch(BASE_URL, {
            method: "POST",
            headers: {
                "x-api-key": API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            body: JSON.stringify({
                model: model,
                max_tokens: 10,
                messages: [{ role: "user", content: SAMPLE_PROMPT }],
            }),
        });

        const latency = Date.now() - start;

        if (!response.ok) {
            return { model, latency, status: response.status, ok: false };
        }

        return { model, latency, status: response.status, ok: true };
    } catch (error) {
        return { model, latency: Date.now() - start, status: error.message, ok: false };
    }
}

async function run() {
    console.log("🚀 Probando modelos de Zai (JS ESM)...\n");
    const results = [];

    for (const model of MODELS) {
        process.stdout.write(`Testing ${model}... `);
        const result = await testModel(model);
        results.push(result);
        console.log(result.ok ? `✅ ${result.latency}ms` : `❌ Error: ${result.status}`);
    }

    console.log("\n📊 Resumen de Rendimiento:");
    console.table(results.map(r => ({
        Modelo: r.model,
        Latencia: r.ok ? `${r.latency}ms` : "N/A",
        Estado: r.status,
        Resultado: r.ok ? "ÉXITO" : "FALLO"
    })));
}

run().catch(console.error);
