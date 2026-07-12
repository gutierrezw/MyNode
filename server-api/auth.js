const config = require("C:/Users/InversionesWildaga/Documents/Claude-Cowork-Scripts/mysql_config.json");
const { tokens } = require("./routes/oauth");

function requireApiKey(req, res, next) {
    // Acepta Bearer token OAuth
    const auth = req.headers["authorization"];
    if (auth && auth.startsWith("Bearer ")) {
        const token = auth.slice(7);
        const stored = tokens()[token];
        if (stored && stored.expires > Date.now()) {
            req.oauth_client = stored.client_id;
            return next();
        }
        return res.status(401).json({ error: "Token inválido o expirado" });
    }

    // Acepta API key directa (Claude Code CLI)
    const key = req.headers["x-api-key"];
    if (key && key === config.api_key) {
        return next();
    }

    return res.status(401).json({ error: "Unauthorized" });
}

module.exports = { requireApiKey };
