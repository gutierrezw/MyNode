const express = require("express");

const router = express.Router();

// Estado en memoria — AppOO lo actualiza via /internal/update
const state = {
  data: {},       // {symbol: {posicion, lotes, vehiculo}}
  prices: {},     // {symbol: {last, ts}}
  current: { symbol: "" },
  contexto: {},
  symbols: [],
  balance: 0.0,
  ping: { t: 0, ever: false },
};

// URL del mini-servidor local de AppOO (order callbacks)
const APPOO_CALLBACK = "http://localhost:5051";

async function forwardToAppoo(path, body) {
  const { default: fetch } = await import("node-fetch");
  const resp = await fetch(`${APPOO_CALLBACK}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  return resp.json();
}

// ── /internal/update — AppOO empuja estado (solo desde localhost) ─────────────
router.post("/update", (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || "";
  const isLocal = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  if (!isLocal) return res.status(403).json({ ok: false, error: "local only" });

  const { type, symbol, payload } = req.body || {};
  try {
    switch (type) {
      case "position":
        if (symbol) state.data[symbol] = payload;
        break;
      case "price":
        if (symbol) state.prices[symbol] = { last: payload.last, ts: Date.now() };
        break;
      case "current":
        state.current.symbol = payload.symbol || "";
        break;
      case "contexto":
        state.contexto = payload;
        break;
      case "symbols":
        state.symbols = payload.symbols || [];
        break;
      case "balance":
        state.balance = payload.usdt_free || 0.0;
        break;
      default:
        return res.status(400).json({ ok: false, error: `unknown type: ${type}` });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /tv/position?symbol=X ─────────────────────────────────────────────────
router.get("/position", (req, res) => {
  const symbol = (req.query.symbol || "").toUpperCase();
  res.json(state.data[symbol] || {});
});

// ── GET /tv/current ───────────────────────────────────────────────────────────
router.get("/current", (req, res) => {
  res.json(state.current);
});

// ── GET /tv/price?symbol=X ────────────────────────────────────────────────────
router.get("/price", (req, res) => {
  const symbol = (req.query.symbol || "").toUpperCase();
  res.json(state.prices[symbol] || {});
});

// ── GET /tv/ping ──────────────────────────────────────────────────────────────
router.get("/ping", (req, res) => {
  state.ping.t = Date.now();
  state.ping.ever = true;
  res.json({ ok: true });
});

// ── GET /tv/ping-status — Python consulta si el panel TV está conectado ───────
router.get("/ping-status", (req, res) => {
  res.json(state.ping);
});

// ── GET /tv/contexto ──────────────────────────────────────────────────────────
router.get("/contexto", (req, res) => {
  res.json(state.contexto);
});

// ── GET /tv/symbols ───────────────────────────────────────────────────────────
router.get("/symbols", (req, res) => {
  const syms = state.symbols.length ? state.symbols : Object.keys(state.data).sort();
  res.json({ symbols: syms });
});

// ── GET /tv/balance ───────────────────────────────────────────────────────────
router.get("/balance", (req, res) => {
  res.json({ usdt_free: state.balance });
});

// ── POST /tv/order — recibe orden de Tampermonkey, reenvía a AppOO ───────────
router.post("/order", async (req, res) => {
  try {
    const result = await forwardToAppoo("/order", req.body);
    res.json(result);
  } catch (e) {
    res.status(502).json({ ok: false, error: `AppOO unreachable: ${e.message}` });
  }
});

// ── POST /tv/current — cambio de símbolo desde Tampermonkey ──────────────────
router.post("/current", async (req, res) => {
  try {
    const result = await forwardToAppoo("/switch", req.body);
    res.json(result);
  } catch (e) {
    res.status(502).json({ ok: false, error: `AppOO unreachable: ${e.message}` });
  }
});

module.exports = router;
module.exports.state = state;
