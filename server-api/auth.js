const config = require("./config.json");

function requireApiKey(req, res, next) {
    const key = req.headers["x-api-key"];
    if (!key || key !== config.api_key) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    next();
}

module.exports = { requireApiKey };
