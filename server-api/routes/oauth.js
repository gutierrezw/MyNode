const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const router = express.Router();

const CLIENTS_FILE = path.join(__dirname, "../oauth_clients.json");
const TOKENS_FILE  = path.join(__dirname, "../oauth_tokens.json");

function loadJson(file, def = {}) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (_) { return def; }
}
function saveJson(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const clients = loadJson(CLIENTS_FILE);
let tokens    = loadJson(TOKENS_FILE);
const authCodes = new Map();

// Limpiar tokens expirados cada minuto
setInterval(() => {
    const now = Date.now();
    let changed = false;
    Object.keys(tokens).forEach(k => {
        if (tokens[k].expires < now) { delete tokens[k]; changed = true; }
    });
    if (changed) saveJson(TOKENS_FILE, tokens);
}, 60000);

// ── GET /oauth/authorize — muestra página de aprobación ───────────────────
router.get("/authorize", (req, res) => {
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type } = req.query;
    if (!clients[client_id]) return res.status(400).send("Cliente no registrado");
    if (response_type !== "code") return res.status(400).send("Solo response_type=code soportado");

    const fields = [
        `<input type="hidden" name="client_id" value="${client_id}">`,
        `<input type="hidden" name="redirect_uri" value="${redirect_uri}">`,
        `<input type="hidden" name="state" value="${state || ""}">`,
        `<input type="hidden" name="code_challenge" value="${code_challenge || ""}">`,
        `<input type="hidden" name="code_challenge_method" value="${code_challenge_method || "S256"}">`,
    ].join("");

    res.send(`<!DOCTYPE html><html><head><title>AppOO — Autorizar acceso</title>
    <style>
      body{font-family:Arial,sans-serif;max-width:420px;margin:80px auto;padding:24px;
           background:#1e2130;color:#d1d4dc;border-radius:8px}
      h2{color:#FFD700;margin-bottom:4px}p{color:#9598a1;font-size:14px}
      .app{font-weight:bold;color:#d1d4dc}
      .perms{background:#161a25;border-radius:6px;padding:12px 16px;margin:16px 0;font-size:13px}
      .perms li{margin:6px 0;color:#9598a1}
      .btns{display:flex;gap:10px;margin-top:20px}
      button{flex:1;padding:12px;border:none;border-radius:4px;font-size:15px;font-weight:bold;cursor:pointer}
      .allow{background:#26a69a;color:#fff}.deny{background:#2a2e39;color:#9598a1;border:1px solid #434651}
    </style></head>
    <body>
    <h2>AppOO</h2>
    <p>La aplicación <span class="app">${clients[client_id].name || client_id}</span> solicita acceso a:</p>
    <ul class="perms">
      <li>📊 Leer posiciones y portfolio</li>
      <li>📈 Consultar datos de mercado y consenso</li>
      <li>🤖 Estado de agentes</li>
      <li>⚡ Ejecutar órdenes (requiere confirmación)</li>
    </ul>
    <form method="POST" action="/oauth/authorize">
      ${fields}
      <div class="btns">
        <button class="allow" name="action" value="allow">Permitir</button>
        <button class="deny" name="action" value="deny">Denegar</button>
      </div>
    </form>
    </body></html>`);
});

// ── POST /oauth/authorize — procesa la aprobación ─────────────────────────
router.post("/authorize", express.urlencoded({ extended: false }), (req, res) => {
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method, action } = req.body;

    const redirectUrl = new URL(redirect_uri);
    if (state) redirectUrl.searchParams.set("state", state);

    if (action !== "allow") {
        redirectUrl.searchParams.set("error", "access_denied");
        return res.redirect(redirectUrl.toString());
    }

    const code = crypto.randomBytes(32).toString("hex");
    authCodes.set(code, {
        client_id,
        redirect_uri,
        code_challenge,
        code_challenge_method: code_challenge_method || "S256",
        expires: Date.now() + 10 * 60 * 1000,
    });

    redirectUrl.searchParams.set("code", code);
    res.redirect(redirectUrl.toString());
});

// ── POST /oauth/token — intercambia código por token ──────────────────────
router.post("/token", express.urlencoded({ extended: false }), express.json(), (req, res) => {
    const { grant_type, code, client_id, client_secret, code_verifier } = req.body;

    if (grant_type !== "authorization_code") {
        return res.status(400).json({ error: "unsupported_grant_type" });
    }

    const stored = authCodes.get(code);
    if (!stored || stored.expires < Date.now()) {
        return res.status(400).json({ error: "invalid_grant", error_description: "Código inválido o expirado" });
    }
    if (stored.client_id !== client_id) {
        return res.status(400).json({ error: "invalid_client" });
    }

    const client = clients[client_id];
    if (!client) return res.status(400).json({ error: "invalid_client" });
    if (client.secret && client.secret !== client_secret) {
        return res.status(400).json({ error: "invalid_client", error_description: "client_secret incorrecto" });
    }

    // Verificar PKCE
    if (stored.code_challenge) {
        if (!code_verifier) {
            return res.status(400).json({ error: "invalid_grant", error_description: "code_verifier requerido" });
        }
        const hash = crypto.createHash("sha256").update(code_verifier).digest("base64url");
        if (hash !== stored.code_challenge) {
            return res.status(400).json({ error: "invalid_grant", error_description: "code_verifier no coincide" });
        }
    }

    authCodes.delete(code);

    const token = crypto.randomBytes(32).toString("hex");
    const expires = Date.now() + 365 * 24 * 60 * 60 * 1000;
    tokens[token] = { client_id, expires };
    saveJson(TOKENS_FILE, tokens);

    res.json({ access_token: token, token_type: "Bearer", expires_in: 365 * 24 * 60 * 60 });
});

module.exports = { router, tokens: () => tokens };
