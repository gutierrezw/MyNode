const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");
const fs = require("fs");
const path = require("path");
const pool = require("../db");
const tvRoutes = require("./tv");

const router = express.Router();

const AUDIT_DIR = path.join(__dirname, "../logs");
if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
const AUDIT_FILE = path.join(AUDIT_DIR, "mcp_audit.jsonl");

function audit(tool, args, result, err = null) {
    const entry = {
        ts: new Date().toISOString(),
        tool,
        args,
        ok: !err,
        summary: err
            ? err.message
            : typeof result === "string"
              ? result.slice(0, 300)
              : JSON.stringify(result).slice(0, 300),
    };
    try {
        fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + "\n");
    } catch (_) {}
}

function errContent(msg) {
    return { content: [{ type: "text", text: msg }], isError: true };
}

function okContent(data) {
    const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    return { content: [{ type: "text", text }] };
}

function createMcpServer() {
    const server = new McpServer({ name: "appoo-api", version: "1.0.0" });

    // ── query_portfolio ────────────────────────────────────────────────────────
    server.tool(
        "query_portfolio",
        "Posiciones activas en el portfolio. Retorna symbol, qty, avg cost, last price, sector, inst_score y consenso tag.",
        {
            account: z.string().optional().describe("ID de cuenta (ej: U4214563). Omitir para todas."),
        },
        async ({ account }) => {
            try {
                let sql = `SELECT i.account, i.symbol, i.position, i.costobase, i.avgcost,
                                  i.vehiculo, i.sector, i.categoriaActivo,
                                  m.lastPrice, m.inst_score, m.rotacion, m.consenso_tag
                           FROM inversion i
                           LEFT JOIN market m ON i.symbol = m.symbol AND i.account = m.account
                           WHERE i.activa = 'S'`;
                const params = [];
                if (account) {
                    sql += " AND i.account = ?";
                    params.push(account);
                }
                sql += " ORDER BY i.account, i.symbol";
                const [rows] = await pool.execute(sql, params);
                audit("query_portfolio", { account }, `${rows.length} rows`);
                return okContent({ count: rows.length, data: rows });
            } catch (e) {
                audit("query_portfolio", { account }, null, e);
                return errContent(`Error: ${e.message}`);
            }
        }
    );

    // ── get_consenso ───────────────────────────────────────────────────────────
    server.tool(
        "get_consenso",
        "Score de consenso de un símbolo: votos por categoría, tag final (UNANIME/CONSENSO/TENDENCIA/etc), inst_score y 13F data.",
        {
            symbol: z.string().describe("Símbolo bursátil (ej: AAPL)"),
        },
        async ({ symbol }) => {
            try {
                const sym = symbol.toUpperCase();
                const [rows] = await pool.execute(
                    `SELECT symbol, account, lastPrice, consenso_tag, consenso_score,
                            net_score, opt_score, flujo_score, ana_score, val_score, cob_score,
                            inst_score, fh_count, fh_buy_ratio, fh_sell_ratio, inst_ownership_pct,
                            rotacion, sector, industry
                     FROM market WHERE symbol = ? LIMIT 5`,
                    [sym]
                );
                if (!rows.length) {
                    audit("get_consenso", { symbol }, null, new Error("not found"));
                    return errContent(`Símbolo ${sym} no encontrado en market`);
                }
                audit("get_consenso", { symbol }, rows[0]);
                return okContent(rows.length === 1 ? rows[0] : rows);
            } catch (e) {
                audit("get_consenso", { symbol }, null, e);
                return errContent(`Error: ${e.message}`);
            }
        }
    );

    // ── get_market_data ────────────────────────────────────────────────────────
    server.tool(
        "get_market_data",
        "Datos de mercado de un símbolo: precio, volumen, márgenes, 13F score. Opcionalmente filtra campos específicos.",
        {
            symbol: z.string().describe("Símbolo bursátil"),
            fields: z.array(z.string()).optional().describe("Lista de campos a retornar. Omitir para resumen estándar."),
        },
        async ({ symbol, fields }) => {
            try {
                const sym = symbol.toUpperCase();
                const [rows] = await pool.execute("SELECT * FROM market WHERE symbol = ? LIMIT 5", [sym]);
                if (!rows.length) {
                    audit("get_market_data", { symbol, fields }, null, new Error("not found"));
                    return errContent(`Símbolo ${sym} no encontrado`);
                }
                const row = rows[0];
                const result = fields
                    ? Object.fromEntries(fields.map((f) => [f, row[f]]))
                    : {
                          symbol: row.symbol,
                          account: row.account,
                          name: row.shortName,
                          sector: row.sector,
                          industry: row.industry,
                          country: row.country,
                          lastPrice: row.lastPrice,
                          volume: row.volume,
                          averageVolume: row.averageVolume,
                          marketCap: row.marketCap,
                          trailingPE: row.trailingPE,
                          grossMargins: row.grossMargins,
                          ebitdaMargins: row.ebitdaMargins,
                          operatingMargins: row.operatingMargins,
                          inst_score: row.inst_score,
                          fh_count: row.fh_count,
                          inst_ownership_pct: row.inst_ownership_pct,
                          consenso_tag: row.consenso_tag,
                          rotacion: row.rotacion,
                      };
                audit("get_market_data", { symbol, fields }, result);
                return okContent(result);
            } catch (e) {
                audit("get_market_data", { symbol, fields }, null, e);
                return errContent(`Error: ${e.message}`);
            }
        }
    );

    // ── get_booktrading ────────────────────────────────────────────────────────
    server.tool(
        "get_booktrading",
        "Historial de operaciones de trading desde booktrading.",
        {
            account: z.string().optional().describe("ID de cuenta"),
            symbol: z.string().optional().describe("Filtrar por símbolo"),
            limit: z.number().int().min(1).max(200).optional().describe("Máx registros (default: 50)"),
        },
        async ({ account, symbol, limit = 50 }) => {
            try {
                let sql = "SELECT * FROM booktrading WHERE 1=1";
                const params = [];
                if (account) {
                    sql += " AND account = ?";
                    params.push(account);
                }
                if (symbol) {
                    sql += " AND symbol = ?";
                    params.push(symbol.toUpperCase());
                }
                sql += " ORDER BY fechahora DESC LIMIT ?";
                params.push(limit);
                const [rows] = await pool.execute(sql, params);
                audit("get_booktrading", { account, symbol, limit }, `${rows.length} rows`);
                return okContent({ count: rows.length, data: rows });
            } catch (e) {
                audit("get_booktrading", { account, symbol, limit }, null, e);
                return errContent(`Error: ${e.message}`);
            }
        }
    );

    // ── execute_order ──────────────────────────────────────────────────────────
    server.tool(
        "execute_order",
        "Ejecuta una orden BUY/SELL via AppOO. Por defecto simula (confirm=false). Requiere confirm=true para ejecutar realmente.",
        {
            symbol: z.string().describe("Símbolo"),
            side: z.enum(["BUY", "SELL"]).describe("Dirección de la orden"),
            price: z.number().positive().describe("Precio límite en USD"),
            qty: z.number().positive().optional().describe("Cantidad en lotes/unidades"),
            importe: z.number().positive().optional().describe("Monto total en USD (alternativa a qty)"),
            vehiculo: z.enum(["Stock", "Crypto"]).optional().describe("Vehículo (default: Stock)"),
            account: z.string().optional().describe("ID de cuenta (default: cuenta activa en app)"),
            confirm: z.boolean().optional().describe("true para ejecutar realmente. false (default) solo previsualiza."),
        },
        async (args) => {
            const { symbol, side, price, qty, importe, vehiculo = "Stock", account = "", confirm = false } = args;

            if (!confirm) {
                const preview = { symbol, side, price, qty, importe, vehiculo, account, status: "SIMULADO — pasa confirm=true para ejecutar" };
                audit("execute_order", args, preview);
                return okContent(preview);
            }

            try {
                const { default: fetch } = await import("node-fetch");
                const body = { symbol, side, price, qty, importe, vehiculo, account };
                const resp = await fetch("http://localhost:5051/order", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(15000),
                });
                const result = await resp.json();
                audit("execute_order", args, result);
                return okContent(result);
            } catch (e) {
                audit("execute_order", args, null, e);
                return errContent(`Error enviando orden a AppOO: ${e.message}`);
            }
        }
    );

    // ── get_agent_status ───────────────────────────────────────────────────────
    server.tool(
        "get_agent_status",
        "Estado actual del servidor: símbolo activo, balance USDT, última conexión de TradingView y símbolos con posición.",
        {},
        async () => {
            try {
                const s = tvRoutes.state;
                const status = s
                    ? {
                          current_symbol: s.current.symbol,
                          symbols_with_position: Object.keys(s.data),
                          symbols_registered: s.symbols.length,
                          balance_usdt_free: s.balance,
                          tv_ever_connected: s.ping.ever,
                          tv_last_ping: s.ping.t ? new Date(s.ping.t).toISOString() : null,
                      }
                    : { error: "Estado no disponible — AppOO no ha enviado datos todavía" };
                audit("get_agent_status", {}, status);
                return okContent(status);
            } catch (e) {
                audit("get_agent_status", {}, null, e);
                return errContent(`Error: ${e.message}`);
            }
        }
    );

    return server;
}

// ── Streamable HTTP — stateless (nueva instancia por request) ──────────────────
router.post("/", async (req, res) => {
    try {
        const server = createMcpServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        res.on("finish", () => server.close().catch(() => {}));
    } catch (e) {
        if (!res.headersSent) res.status(500).json({ error: e.message });
    }
});

router.get("/", async (req, res) => {
    try {
        const server = createMcpServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        await transport.handleRequest(req, res);
        res.on("finish", () => server.close().catch(() => {}));
    } catch (e) {
        if (!res.headersSent) res.status(500).json({ error: e.message });
    }
});

router.delete("/", async (req, res) => {
    res.status(200).json({ ok: true });
});

module.exports = router;
