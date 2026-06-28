const mysql = require("mysql2/promise");
const config = require("C:/Users/InversionesWildaga/Documents/Claude-Cowork-Scripts/mysql_config.json");

const pool = mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});

module.exports = pool;
