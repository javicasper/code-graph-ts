
import "dotenv/config";

const API_KEY = process.env.ZAI_API_KEY;
const BASE_URL = "https://api.z.ai/api/anthropic/v1/messages";

// Estrategia propuesta: 18 slots en total
const MODEL_POOL = [
    { name: "glm-4.7", limit: 3 },
    { name: "glm-4.6", limit: 3 },
    { name: "glm-4.5-air", limit: 5 },
    { name: "glm-4.5", limit: 7 }
];

const TOTAL_REQUESTS = 36; // 2 ráfagas completas de los 18 slots
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
            return { ok: false, status: response.status, latency, modelName };
        }
        return { ok: true, latency, modelName };
    } catch (error) {
        return { ok: false, status: error.message, latency: Date.now() - start, modelName };
    }
}

async function runCombinedBenchmark() {
    console.log(`🚀 Probando COMBINACIÓN PARALELA (Pool de 18 slots)`);
    console.log(`📡 Modelos: ${MODEL_POOL.map(m => `${m.name}(${m.limit})`).join(", ")}\n`);

    const start = Date.now();

    // Creamos la lista de tareas: cada tarea asignada a un modelo respetando su límite
    const allPromises = [];
    for (const config of MODEL_POOL) {
        // Lanzamos 2 ráfagas de su límite para este modelo
        for (let i = 0; i < config.limit * 2; i++) {
            allPromises.push(testModel(config.name));
        }
    }

    console.log(`⏳ Lanzando ${allPromises.length} peticiones simultáneas...`);
    const results = await Promise.all(allPromises);

    const totalTime = (Date.now() - start) / 1000;
    const successes = results.filter(r => r.ok).length;
    const errors = results.filter(r => !r.ok);

    console.log("\n📊 Resultado del Pool Combinado:");
    console.log(`- Tiempo total: ${totalTime.toFixed(2)}s`);
    console.log(`- Éxitos: ${successes}/${results.length}`);
    console.log(`- Rendimiento: ${(successes / totalTime).toFixed(2)} desc/seg`);

    if (errors.length > 0) {
        console.warn("\n⚠️ Errores detectados:");
        const errorStats = {};
        errors.forEach(e => {
            const key = `${e.modelName} (${e.status})`;
            errorStats[key] = (errorStats[key] || 0) + 1;
        });
        console.table(errorStats);
    } else {
        console.log("\n✅ ¡Perfecto! Ningún error de Rate Limit.");
    }
}

if (!API_KEY) {
    console.error("❌ ZAI_API_KEY no encontrada.");
} else {
    runCombinedBenchmark().catch(console.error);
}
