// Reporte semanal de salud del schema MySQL (bdinv) — corre vía Windows Task Scheduler.
// Conecta DIRECTO a MySQL (mismo equipo, no necesita server-api corriendo) y deja el
// resultado en un archivo HTML local para revisar (NO envía email).
//
// Requiere:
//   - MySQL local corriendo (localhost:3306)
//   - Documents\Claude-Cowork-Scripts\mysql_config.json   (db: host, port, user, password, database)

const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

const CONFIG_PATH = "C:/Users/InversionesWildaga/Documents/Claude-Cowork-Scripts/mysql_config.json";
const config = require(CONFIG_PATH);

const LOG_DIR = path.join(__dirname, "logs");
const OUTPUT_DIR = path.join(__dirname, "output");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const fecha = new Date().toISOString().slice(0, 10);
const logFile = path.join(LOG_DIR, `report-${fecha}.log`);
function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(logFile, line);
    console.log(msg);
}

function tablaHtml(headers, rows, color = "#f0f4ff") {
    const h = headers
        .map((c) => `<th style="padding:6px 12px;background:#3a5fa0;color:white">${c}</th>`)
        .join("");
    const body = rows
        .map((r, i) => {
            const bg = i % 2 === 0 ? color : "#ffffff";
            return (
                "<tr>" +
                Object.values(r)
                    .map((c) => `<td style="padding:5px 12px;border-bottom:1px solid #ddd;background:${bg}">${c}</td>`)
                    .join("") +
                "</tr>"
            );
        })
        .join("");
    return `<table style="border-collapse:collapse;width:100%;margin-bottom:20px"><tr>${h}</tr>${body}</table>`;
}

function buildHtml(diag) {
    const { database, tablas, indices_sin_uso, full_scans, buffer_pool } = diag;
    const bpUso = buffer_pool.en_uso_gb;
    const bpConf = buffer_pool.configurado_gb;
    const bpPct = bpConf > 0 ? Math.round((bpUso / bpConf) * 1000) / 10 : 0;

    const alertaScans = full_scans.length
        ? `<p style="color:#c0392b;font-weight:bold">⚠️ ${full_scans.length} queries con full scan detectadas</p>`
        : `<p style="color:green">✅ Sin full scans detectados</p>`;
    const alertaIdx = indices_sin_uso.length
        ? `<p style="color:#e67e22">⚠️ ${indices_sin_uso.length} índices con 0 uso</p>`
        : `<p style="color:green">✅ Todos los índices tienen actividad</p>`;

    return `
<html><body style="font-family:Arial,sans-serif;max-width:900px;margin:auto;padding:20px">
<h2 style="color:#2c3e50">🛠️ Reporte Semanal MySQL — schema: ${database}</h2>
<p style="color:#7f8c8d">Generado: ${fecha}</p>
<hr>
<h3>📊 Buffer Pool</h3>
<p>Configurado: <b>${bpConf} GB</b> | En uso: <b>${bpUso} GB</b> (${bpPct}% utilizado)</p>
<hr>
<h3>📦 Tablas por Tamaño</h3>
${tablaHtml(["Tabla", "Filas", "Datos MB", "Índices MB", "Total MB"], tablas)}
<hr>
<h3>🚨 Queries con Full Scan</h3>
${alertaScans}
${full_scans.length ? tablaHtml(["Query", "Veces", "Avg seg", "Filas exam", "Sin índice"], full_scans) : ""}
<hr>
<h3>⚠️ Índices No Utilizados</h3>
${alertaIdx}
${indices_sin_uso.length ? tablaHtml(["Tabla", "Índice", "Lecturas", "Escrituras"], indices_sin_uso) : ""}
<hr>
<p style="color:#95a5a6;font-size:12px">Reporte automático — MySQL 8.x / schema ${database}</p>
</body></html>`;
}

function writeOutput(html) {
    const datedFile = path.join(OUTPUT_DIR, `reporte-${fecha}.html`);
    const latestFile = path.join(OUTPUT_DIR, `reporte_ultimo.html`);
    fs.writeFileSync(datedFile, html, "utf8");
    fs.writeFileSync(latestFile, html, "utf8");
    return { datedFile, latestFile };
}

async function getDiagnostics() {
    const conn = await mysql.createConnection({
        host: config.db.host,
        port: config.db.port,
        user: config.db.user,
        password: config.db.password,
        database: config.db.database,
    });

    try {
        const dbName = config.db.database;

        const [tablas] = await conn.query(
            `SELECT TABLE_NAME AS tabla, TABLE_ROWS AS filas,
                    ROUND(DATA_LENGTH/1024/1024,2) AS datos_mb,
                    ROUND(INDEX_LENGTH/1024/1024,2) AS indices_mb,
                    ROUND((DATA_LENGTH+INDEX_LENGTH)/1024/1024,2) AS total_mb
             FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
             ORDER BY (DATA_LENGTH+INDEX_LENGTH) DESC`,
            [dbName]
        );

        const [indices_sin_uso] = await conn.query(
            `SELECT object_name AS tabla, index_name AS indice,
                    count_read AS lecturas, count_write AS escrituras
             FROM performance_schema.table_io_waits_summary_by_index_usage
             WHERE object_schema = ?
               AND index_name IS NOT NULL AND index_name != 'PRIMARY'
               AND count_read = 0 AND count_write = 0
             ORDER BY object_name`,
            [dbName]
        );

        const [full_scans] = await conn.query(
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

        const [[bpUso]] = await conn.query(
            `SELECT ROUND(variable_value/1024/1024/1024,2) AS gb
             FROM performance_schema.global_status
             WHERE variable_name = 'Innodb_buffer_pool_bytes_data'`
        );

        const [[bpConf]] = await conn.query(
            `SELECT ROUND(@@innodb_buffer_pool_size/1024/1024/1024,2) AS gb`
        );

        return {
            database: dbName,
            tablas,
            indices_sin_uso,
            full_scans,
            buffer_pool: {
                en_uso_gb: bpUso ? bpUso.gb : null,
                configurado_gb: bpConf ? bpConf.gb : null,
            },
        };
    } finally {
        await conn.end();
    }
}

async function main() {
    log("Iniciando reporte semanal MySQL...");
    log(`Credenciales leídas de: ${CONFIG_PATH}`);

    const diag = await getDiagnostics();
    const html = buildHtml(diag);
    const { datedFile, latestFile } = writeOutput(html);

    log(`REPORTE_OK — full_scans:${diag.full_scans.length} sin_uso:${diag.indices_sin_uso.length} buffer:${diag.buffer_pool.en_uso_gb}GB/${diag.buffer_pool.configurado_gb}GB`);
    log(`Salida guardada en: ${datedFile}`);
    log(`(también actualizado: ${latestFile})`);
}

main().catch((err) => {
    log(`ERROR: ${err.message}`);
    const errorHtml = `<html><body style="font-family:Arial,sans-serif;padding:20px">
<h2 style="color:#c0392b">❌ Error en Reporte Semanal MySQL — ${fecha}</h2>
<p>${err.message}</p>
</body></html>`;
    writeOutput(errorHtml);
    process.exit(1);
});
