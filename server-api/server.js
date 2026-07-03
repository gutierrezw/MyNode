const express = require("express");
const rateLimit = require("express-rate-limit");
const config = require("C:/Users/InversionesWildaga/Documents/Claude-Cowork-Scripts/mysql_config.json");
const { requireApiKey } = require("./auth");
const dbRoutes = require("./routes/db");
const tvRoutes = require("./routes/tv");
const mcpRoutes = require("./routes/mcp");

const app = express();
app.use(express.json());

const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    message: { error: "Rate limit excedido — máx 120 req/min" },
});

app.get("/health", (req, res) => {
    res.json({ status: "ok", version: "1.0.0", uptime: process.uptime() });
});

app.use("/db", requireApiKey, dbRoutes);

// /tv/* público (Tampermonkey) — con rate limit
// /internal/* solo localhost, validado por IP en el handler — sin rate limit
// /mcp — MCP server para Claude co-work, requiere API key
app.use("/tv", limiter, tvRoutes);
app.use("/internal", tvRoutes);
app.use("/mcp", requireApiKey, mcpRoutes);

app.use((req, res) => {
    res.status(404).json({ error: "Endpoint no encontrado" });
});

const PORT = config.port || 8050;
app.listen(PORT, () => {
    console.log(`server-api escuchando en puerto ${PORT}`);
});
