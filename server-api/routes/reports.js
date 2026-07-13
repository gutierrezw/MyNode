const express = require("express");
const pool = require("../db");
const ReportManager = require("../lib/ReportManager");
const { getSchemaHealth } = require("../lib/schemaHealth");
const { renderPage } = require("../lib/reportPage");

const router = express.Router();

// ── schema_health — único consumidor hoy. Nuevo tipo_reporte = nueva función acá + entrada en DISPATCH.
function extraerTablas(sql) {
    if (!sql) return null;
    const regex = /\b(?:FROM|JOIN)\s+`?(\w+)`?/gi;
    const tablas = new Set();
    let m;
    while ((m = regex.exec(sql)) !== null) {
        tablas.add(m[1]);
    }
    return tablas.size ? [...tablas].join(",") : null;
}

async function runSchemaHealth() {
    const health = await getSchemaHealth(pool);

    for (const row of health.full_scans) {
        const tablas = extraerTablas(row.query_sample_text);
        await ReportManager.registrar(pool, "schema_health", "full_scan", row.query_text.slice(0, 64), row, tablas);
    }
    for (const row of health.indices_sin_uso) {
        const referencia = `${row.tabla}.${row.indice}`.slice(0, 64);
        await ReportManager.registrar(pool, "schema_health", "indice_sin_uso", referencia, row, row.tabla);
    }
    const tablasGrandes = health.tablas.slice(0, 5);
    for (const row of tablasGrandes) {
        await ReportManager.registrar(pool, "schema_health", "tabla_grande", row.tabla.slice(0, 64), row, row.tabla);
    }
    await ReportManager.registrar(pool, "schema_health", "buffer_pool", "global", health.buffer_pool);

    return {
        full_scan: health.full_scans.length,
        indice_sin_uso: health.indices_sin_uso.length,
        tabla_grande: tablasGrandes.length,
        buffer_pool: 1,
    };
}

const DISPATCH = {
    schema_health: runSchemaHealth,
};

// ── POST /:tipo/run — trigger genérico (montado en /reports y /internal/reports) ──────────────
router.post("/:tipo/run", async (req, res) => {
    const { tipo } = req.params;
    const handler = DISPATCH[tipo];
    if (!handler) return res.status(404).json({ error: `tipo_reporte desconocido: ${tipo}` });
    try {
        const registrados = await handler();
        res.json({ ok: true, tipo_reporte: tipo, registrados });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── GET /:tipo — página HTML con los hallazgos activos de la corrida más reciente ─────────────
router.get("/:tipo", async (req, res) => {
    try {
        const rows = await ReportManager.ultimo(pool, req.params.tipo);
        res.send(renderPage(req.params.tipo, rows));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── GET /:tipo/historico?referencia=X — serie histórica de un caso puntual ────────────────────
router.get("/:tipo/historico", async (req, res) => {
    const { referencia } = req.query;
    if (!referencia) return res.status(400).json({ error: "referencia requerida" });
    try {
        const rows = await ReportManager.historico(pool, req.params.tipo, referencia);
        res.json({ count: rows.length, data: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── POST /:tipo/:id/resolver — cierra un hallazgo puntual ──────────────────────────────────────
router.post("/:tipo/:id/resolver", async (req, res) => {
    const { propuesta_correccion } = req.body || {};
    try {
        await ReportManager.marcarResuelto(pool, req.params.id, propuesta_correccion);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── POST /:tipo/:id/proponer — marca el hallazgo como pendiente de análisis (no ejecuta nada solo,
//    queda a la espera de que se revise en una sesión de Code) ─────────────────────────────────
router.post("/:tipo/:id/proponer", async (req, res) => {
    try {
        await ReportManager.marcarPropuesto(pool, req.params.id);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── POST /:tipo/:id/descartar — cierra un hallazgo "no reproducido" sin confirmar fix (distinto
//    de /resolver: no afirma que se corrigió, solo destapa la cola; reaparece fresco si recurre) ──
router.post("/:tipo/:id/descartar", async (req, res) => {
    const { nota } = req.body || {};
    try {
        await ReportManager.marcarDescartado(pool, req.params.id, nota);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
