
import "dotenv/config";

const API_KEY = process.env.ZAI_API_KEY;
const BASE_URL = "https://api.z.ai/api/anthropic/v1/messages";

// Configuración de modelos con sus límites específicos
const MODEL_CONFIGS = [
    { name: "glm-4.5", limit: 10 },
    { name: "glm-4.7", limit: 3 },
    { name: "glm-4.5-air", limit: 5 },
    { name: "glm-4.6", limit: 3 },
    { name: "glm-4-plus", limit: 20 },
    { name: "glm-4.5-airx", limit: 5 },
    { name: "glm-4.7-flash", limit: 1 }
];

const SAMPLE_PROMPT = "Di 'OK' y nada más.";

async function testModel(modelName) {
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
                model: modelName,
                max_tokens: 10,
                messages: [{ role: "user", content: SAMPLE_PROMPT }],
            }),
        });

        const latency = Date.now() - start;
        if (!response.ok) {
            return { ok: false, status: response.status, latency };
        }
        return { ok: true, latency };
    } catch (error) {
        return { ok: false, status: error.message, latency: Date.now() - start };
    }
}

async function benchmarkModelIndependent(config) {
    console.log(`\n� Probando ${config.name} con concurrencia ${config.limit}...`);

    // Vamos a lanzar 2 rondas de su límite para ver estabilidad
    const totalRequests = config.limit * 2;
    const start = Date.now();

    // Lanzamos todas en paralelo (su límite máximo)
    const promises = Array.from({ length: totalRequests }, () => testModel(config.name));
    const results = await Promise.all(promises);

    const totalTime = (Date.now() - start) / 1000;
    const successes = results.filter(r => r.ok).length;
    const avgLatency = Math.round(results.reduce((acc, r) => acc + r.latency, 0) / results.length);

    return {
        Modelo: config.name,
        Límite: config.limit,
        Éxitos: `${successes}/${totalRequests}`,
        LatenciaMedia: `${avgLatency}ms`,
        "Desc/seg": (successes / totalTime).toFixed(2),
        Estado: successes === totalRequests ? "✅ OK" : "⚠️ Inestable"
    };
}

async function run() {
    if (!API_KEY) {
        console.error("❌ ZAI_API_KEY no encontrada.");
        return;
    }

    console.log("🚀 Iniciando Benchmark Independiente por Modelo\n");
    const summary = [];

    for (const config of MODEL_CONFIGS) {
        const result = await benchmarkModelIndependent(config);
        summary.push(result);
        // Pequeño respiro entre modelos
        await new Promise(r => setTimeout(r, 1000));
    }

    console.log("\n📊 Resumen de Rendimiento (Independiente):");
    console.table(summary);
}

run().catch(console.error);
