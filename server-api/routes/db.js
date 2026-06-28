const express = require("express");
const pool = require("../db");
const config = require("C:/Users/InversionesWildaga/Documents/Claude-Cowork-Scripts/mysql_config.json");

const router = express.Router();

const ALLOWED_TABLES = new Set([
    "market", "inversion", "booktrading", "fund_holdings",
    "diaria_cnv", "market_sentiment", "extractos",
]);

router.get("/portfolio", async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT i.account, i.symbol, i.position, i.costobase, i.avgcost,
                    i.activa, i.vehiculo, i.sector, i.categoriaActivo,
                    m.lastPrice, m.inst_score, m.rotacion
             FROM inversion i
             LEFT JOIN market m ON i.symbol = m.symbol AND i.account = m.account
             WHERE i.activa = 'S'
             ORDER BY i.account, i.symbol`
        );
        res.json({ count: rows.length, data: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get("/market", async (req, res) => {
    const { symbol } = req.query;
    if (!symbol) return res.status(400).json({ error: "symbol requerido" });
    try {
        const [rows] = await pool.query(
            `SELECT * FROM market WHERE symbol = ? LIMIT 10`,
            [symbol.toUpperCase()]
        );
        res.json({ count: rows.length, data: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get("/consenso", async (req, res) => {
    const { symbol } = req.query;
    if (!symbol) return res.status(400).json({ error: "symbol requerido" });
    try {
        const [rows] = await pool.query(
            `SELECT symbol, account, lastPrice, inst_score, inst_ownership_pct,
                    fh_count, fh_buy_ratio, fh_sell_ratio, rotacion,
                    sector, industry, country
             FROM market WHERE symbol = ? LIMIT 10`,
            [symbol.toUpperCase()]
        );
        res.json({ count: rows.length, data: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get("/booktrading", async (req, res) => {
    const { account, symbol } = req.query;
    if (!account) return res.status(400).json({ error: "account requerido" });
    try {
        let sql = "SELECT * FROM booktrading WHERE account = ?";
        const params = [account];
        if (symbol) {
            sql += " AND symbol = ?";
            params.push(symbol.toUpperCase());
        }
        sql += " ORDER BY fechahora DESC LIMIT 200";
        const [rows] = await pool.query(sql, params);
        res.json({ count: rows.length, data: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get("/extractos", async (req, res) => {
    const { account } = req.query;
    if (!account) return res.status(400).json({ error: "account requerido" });
    try {
        const [rows] = await pool.query(
            `SELECT * FROM extractos WHERE account = ? ORDER BY fecha DESC LIMIT 200`,
            [account]
        );
        res.json({ count: rows.length, data: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post("/query", async (req, res) => {
    const { sql, params } = req.body;
    if (!sql) return res.status(400).json({ error: "sql requerido" });

    const normalized = sql.trim().toLowerCase();
    if (!normalized.startsWith("select")) {
        return res.status(403).json({ error: "Solo se permiten SELECT" });
    }

    const tableMatch = normalized.match(/from\s+(\w+)/);
    if (!tableMatch || !ALLOWED_TABLES.has(tableMatch[1])) {
        return res.status(403).json({
            error: "Tabla no permitida",
            allowed: [...ALLOWED_TABLES],
        });
    }

    try {
        const [rows] = await pool.query(sql, params || []);
        res.json({ count: rows.length, data: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Reporte semanal de salud del schema — solo lectura, queries fijas (no toma input del cliente).
router.get("/diagnostics", async (req, res) => {
    try {
        const dbName = config.db.database;

        const [tablas] = await pool.query(
            `SELECT TABLE_NAME AS tabla, TABLE_ROWS AS filas,
                    ROUND(DATA_LENGTH/1024/1024,2) AS datos_mb,
                    ROUND(INDEX_LENGTH/1024/1024,2) AS indices_mb,
                    ROUND((DATA_LENGTH+INDEX_LENGTH)/1024/1024,2) AS total_mb
             FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
             ORDER BY (DATA_LENGTH+INDEX_LENGTH) DESC`,
            [dbName]
        );

        const [indices_sin_uso] = await pool.query(
            `SELECT object_name AS tabla, index_name AS indice,
                    count_read AS lecturas, count_write AS escrituras
             FROM performance_schema.table_io_waits_summary_by_index_usage
             WHERE object_schema = ?
               AND index_name IS NOT NULL AND index_name != 'PRIMARY'
               AND count_read = 0 AND count_write = 0
             ORDER BY object_name`,
            [dbName]
        );

        const [full_scans] = await pool.query(
            `SELECT SUBSTRING(digest_text,1,80) AS query_text,
                    count_star AS veces,
                    ROUND(avg_timer_wait/1000000000,2) AS avg_seg,
                    sum_rows_examined AS filas_examinadas,
                    sum_no_index_used AS sin_indice
             FROM performance_schema.events_statements_summary_by_digest
             WHERE digest_text NOT LIKE '%performance_schema%'
               AND digest_text NOT LIKE '%information_schema%'
               AND sum_no_index_used > 0
             ORDER BY sum_rows_examined DESC
             LIMIT 10`
        );

        const [[bpUso]] = await pool.query(
            `SELECT ROUND(variable_value/1024/1024/1024,2) AS gb
             FROM performance_schema.global_status
             WHERE variable_name = 'Innodb_buffer_pool_bytes_data'`
        );

        const [[bpConf]] = await pool.query(
            `SELECT ROUND(@@innodb_buffer_pool_size/1024/1024/1024,2) AS gb`
        );

        res.json({
            database: dbName,
            generado: new Date().toISOString(),
            tablas,
            indices_sin_uso,
            full_scans,
            buffer_pool: {
                en_uso_gb: bpUso ? bpUso.gb : null,
                configurado_gb: bpConf ? bpConf.gb : null,
            },
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
