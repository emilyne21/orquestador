// server.js
import express from "express";
import axios from "axios";
import swaggerUi from "swagger-ui-express";
import YAML from "yamljs";
import cors from "cors";
import morgan from "morgan";

// ------------------ Config básica ------------------
const ENV = process.env.NODE_ENV || "development";
const PORT = Number(process.env.PORT || 8085);

// CORS
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// Util para exigir vars en prod
const must = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`[orq] Falta la variable de entorno ${name}`);
  return v;
};

// URLs de microservicios (estrictas en prod, cómodas en dev)
const INVENTARIO_URL =
  ENV === "production"
    ? must("INVENTARIO_URL")
    : process.env.INVENTARIO_URL || "http://localhost:8082";

const RECETAS_URL =
  ENV === "production"
    ? must("RECETAS_URL")
    : process.env.RECETAS_URL || "http://localhost:8083";

const CATALOGO_URL =
  ENV === "production"
    ? must("CATALOGO_URL")
    : process.env.CATALOGO_URL || "http://localhost:8084";

// Cliente HTTP
const http = axios.create({
  timeout: Number(process.env.UPSTREAM_TIMEOUT_MS || 5000),
  maxRedirects: 3,
});

// ------------------ App ------------------
const app = express();

app.use(
  cors({
    origin: CORS_ORIGINS.includes("*") ? true : CORS_ORIGINS,
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  })
);

app.use(express.json({ limit: "1mb" }));
app.use(morgan(ENV === "production" ? "tiny" : "dev"));

// ------------------ Util errores ------------------
const mapUpstreamError = (e) => {
  if (e.response) {
    return {
      status: e.response.status,
      body: {
        error: "Upstream error",
        upstream_status: e.response.status,
        upstream_body: e.response.data,
      },
    };
  }
  if (e.request) {
    return { status: 504, body: { error: "Upstream timeout/unreachable" } };
  }
  return { status: 500, body: { error: "Orchestrator error", detail: String(e) } };
};

// ------------------ Rutas ------------------

// Health
app.get("/healthz", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({ status: "ok" });
});

// Disponibilidad: junta Catálogo + Inventario
app.get("/disponibilidad", async (req, res) => {
  try {
    const { id_producto, distrito } = req.query;
    if (!id_producto) return res.status(400).json({ error: "id_producto requerido" });

    const [producto, sucursales] = await Promise.all([
      http
        .get(`${CATALOGO_URL}/productos/${encodeURIComponent(id_producto)}`)
        .then((r) => r.data)
        .catch((e) => {
          // Si Catálogo devuelve 404, respondemos producto = null
          if (e.response && e.response.status === 404) return null;
          throw e;
        }),
      http
        .get(`${INVENTARIO_URL}/stock`, {
          params: { id_producto, distrito },
        })
        .then((r) => r.data),
    ]);

    return res.json({ producto, sucursales });
  } catch (e) {
    const { status, body } = mapUpstreamError(e);
    return res.status(status).json(body);
  }
});

// Validación de una receta contra Inventario
app.get("/recetas/:id_receta/validacion", async (req, res) => {
  try {
    const id = req.params.id_receta;

    // Trae la receta con su detalle
    const receta = await http
      .get(`${RECETAS_URL}/recetas/${encodeURIComponent(id)}`)
      .then((r) => r.data);

    // Para cada item, suma disponibilidad total y sugiere sucursal con stock suficiente
    const items = await Promise.all(
      (receta.detalle || []).map(async (it) => {
        const stockList = await http
          .get(`${INVENTARIO_URL}/stock`, { params: { id_producto: it.id_producto } })
          .then((r) => r.data);

        const cantidadField = (s) =>
          s.cantidad_actual ?? s.stock_actual ?? s.cantidad ?? 0;

        const total = (stockList || []).reduce((acc, s) => acc + Number(cantidadField(s)), 0);

        const sugerida =
          (stockList || []).find((s) => Number(cantidadField(s)) >= Number(it.cantidad))
            ?.id_sucursal ?? null;

        return {
          id_producto: it.id_producto,
          solicitado: Number(it.cantidad),
          disponible: Number(total),
          id_sucursal_sugerida: sugerida,
        };
      })
    );

    const ok = items.every((i) => i.disponible >= i.solicitado);
    const parcial = !ok && items.some((i) => i.disponible > 0);

    return res.json({
      id_receta: receta.id_receta,
      estado_sugerido: ok ? "VALIDADA" : parcial ? "PARCIAL" : "RECHAZADA",
      items,
    });
  } catch (e) {
    // Propaga 404 si la receta no existe, etc.
    const { status, body } = mapUpstreamError(e);
    return res.status(status).json(body);
  }
});

// ------------------ Swagger opcional ------------------
if (process.env.SERVE_DOCS === "1") {
  const specPath = process.env.OPENAPI_FILE || "./docs/orquestador.yaml";
  try {
    const spec = YAML.load(specPath);
    app.use("/swagger", swaggerUi.serve, swaggerUi.setup(spec));
    console.log(`[orq] Swagger montado en /swagger (spec: ${specPath})`);
  } catch (e) {
    console.warn(`[orq] No se pudo cargar el OpenAPI: ${specPath} -> ${e.message}`);
  }
}

// 404
app.use((_req, res) => res.status(404).json({ detail: "Not found" }));

// Manejo de errores genérico
app.use((err, _req, res, _next) => {
  console.error("[orq] error:", err);
  const { status, body } = mapUpstreamError(err);
  res.status(status).json(body);
});

// ------------------ Start ------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[orq] escuchando en :${PORT} (${ENV})`);
  console.log(`[orq] INVENTARIO_URL=${INVENTARIO_URL}`);
  console.log(`[orq] RECETAS_URL=${RECETAS_URL}`);
  console.log(`[orq] CATALOGO_URL=${CATALOGO_URL}`);
});
