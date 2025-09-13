import express, { Request, Response } from 'express';
import axios from 'axios';
import * as dotenv from 'dotenv';
dotenv.config();
import { z, ZodType } from 'zod';
import * as client from 'prom-client';

// --- Métrica de Prometheus ---
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const anomalyGauge = new client.Gauge({
  name: 'mcp_aiops_anomaly',
  help: 'Indica si se detectó una anomalía: 1=Sí, 2=Potencial, 0=No'
});
register.registerMetric(anomalyGauge);

// --- Función para reducir y explicar la respuesta de Gemini ---
function extractAnomalyAndExplanation(text: string): { value: number, label: string, explanation: string } {
  // Busca la línea "Anomalía Detectada: ..." y la interpreta
  const match = text.match(/Anomalía Detectada:\s*(Sí|No|Potencial)/i);
  let value = 0, label = "No";
  if (match) {
    switch (match[1].toLowerCase()) {
      case 'sí': value = 1; label = "Sí"; break;
      case 'potencial': value = 2; label = "Potencial"; break;
      case 'no': value = 0; label = "No"; break;
    }
  }

  // Busca la justificación después de "Justificación:"
  const expMatch = text.match(/Justificación:\s*([^\n]+)/i);
  let explanation = expMatch ? expMatch[1].trim() : "Sin explicación.";

  // Limita la explicación a 50 palabras
  const words = explanation.split(/\s+/);
  if (words.length > 50) {
    explanation = words.slice(0, 50).join(' ') + '...';
  }

  return { value, label, explanation };
}

// --- Tu función createContext y esquema se mantienen igual ---
const createContext = (contextData: { schema: ZodType, data: any, description: string }) => {
  return {
    protocol: "model-context-protocol/v1",
    description: contextData.description,
    schema: {
      type: "zod/json",
      definition: contextData.schema.description || "SystemStateSchema"
    },
    data: contextData.data,
  };
};

const PORT: number = parseInt(process.env.PORT || '8080', 10);
const PROMETHEUS_URL: string = process.env.PROMETHEUS_URL || "http://prometheus:9090";
const GEMINI_API_KEY: string = process.env.GEMINI_API_KEY as string;

const SystemStateSchema = z.object({
  cpu_usage_rate_5m: z.number().nullable(),
  load_average_1m: z.number().nullable(),
  memory_available_mb: z.number().nullable(),
  timestamp: z.number()
});
type SystemState = z.infer<typeof SystemStateSchema>;

interface GeminiResponse {
  candidates: {
    content: {
      parts: { text: string; }[];
    };
  }[];
}

const app = express();

app.get('/aiops/check', async (req: Request, res: Response) => {
  try {
    const queries = {
      cpuRate: `rate(node_cpu_seconds_total{mode='user'}[5m])`,
      loadAvg: 'node_load1',
      memAvailable: 'node_memory_MemAvailable_bytes'
    };

    const [cpuRes, loadRes, memRes] = await axios.all([
      axios.get(`${PROMETHEUS_URL}/api/v1/query`, { params: { query: queries.cpuRate } }),
      axios.get(`${PROMETHEUS_URL}/api/v1/query`, { params: { query: queries.loadAvg } }),
      axios.get(`${PROMETHEUS_URL}/api/v1/query`, { params: { query: queries.memAvailable } })
    ]);

    const extractValue = (response: any): number | null => {
      const result = response.data.data.result[0];
      return result ? parseFloat(result.value[1]) : null;
    };

    const cpuUsageRate = extractValue(cpuRes);
    const loadAverage = extractValue(loadRes);
    const memoryAvailableBytes = extractValue(memRes);

    const systemState: SystemState = {
      cpu_usage_rate_5m: cpuUsageRate,
      load_average_1m: loadAverage,
      memory_available_mb: memoryAvailableBytes ? memoryAvailableBytes / (1024 * 1024) : null,
      timestamp: Date.now()
    };

    const validatedData = SystemStateSchema.parse(systemState);

    const context = createContext({
      schema: SystemStateSchema,
      data: validatedData,
      description: 'Estado de métricas operacionales de un servidor para análisis AIOps'
    });

    const prompt = `
      Eres un ingeniero experto en SRE (Site Reliability Engineering).
      Analiza el siguiente estado de un servidor para detectar posibles anomalías operacionales.
      Estado del sistema en los últimos 5 minutos:
      - Tasa de uso de CPU (modo 'user'): ${validatedData.cpu_usage_rate_5m?.toFixed(4) || 'N/A'}
      - Promedio de carga (1 minuto): ${validatedData.load_average_1m?.toFixed(2) || 'N/A'}
      - Memoria disponible: ${validatedData.memory_available_mb?.toFixed(2) || 'N/A'} MB
      Basado en estos datos, responde con:
      1. **Anomalía Detectada:** (Sí/No/Potencial).
      2. **Justificación:** (Una explicación concisa de por qué, considerando la relación entre las métricas).
      3. **Recomendación:** (Un siguiente paso sugerido).
      Limita la justificación a un máximo de 50 palabras.
    `;

    const geminiRes = await axios.post<GeminiResponse>(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
      { contents: [{ parts: [{ text: prompt }] }] },
      { params: { key: GEMINI_API_KEY } }
    );

    const analysis = geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text || "Análisis no disponible por parte de Gemini.";

    // --- REDUCE LA RESPUESTA Y LA EXPLICACIÓN ---
    const { value: anomalyValue, label: anomalyLabel, explanation } = extractAnomalyAndExplanation(analysis);
    anomalyGauge.set(anomalyValue);

    res.json({
      context,
      anomaly: anomalyLabel, // "Sí", "No", "Potencial"
      explanation,           // máx. 50 palabras
      analysis               // texto completo de Gemini
    });

  } catch (error) {
    console.error("Error en /aiops/check:", error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Datos de la métrica inválidos.", details: error.issues });
    }
    if (axios.isAxiosError(error)) {
      return res.status(502).json({ error: "Error de comunicación con un servicio externo.", service: error.config?.url });
    }
    res.status(500).json({ error: 'Ocurrió un error interno en el servidor.' });
  }
});

// --- Endpoint Prometheus ---
app.get('/metrics', async (req: Request, res: Response) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.listen(PORT, () => {
  if (!GEMINI_API_KEY) {
    console.warn("ADVERTENCIA: La variable de entorno GEMINI_API_KEY no está configurada. Asegúrate de tener un archivo .env");
  }
  console.log(`MCP-AIOps (TypeScript) escuchando en el puerto ${PORT}`);
});