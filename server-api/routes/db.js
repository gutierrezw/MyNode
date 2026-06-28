const express = require("express");
const pool = require("../db");

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

module.exports = router;
