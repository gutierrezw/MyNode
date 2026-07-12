// Analiza las queries con full scan (performance_schema.events_statements_summary_by_digest)
// y genera un .sql con CREATE INDEX recomendados para revisar y ejecutar manualmente.
// NO ejecuta ningún DDL — solo deja el archivo .sql listo en .\output\
//
// Uso:
//   node analyze-fullscan.js
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
const logFile = path.join(LOG_DIR, `analyze-fullscan-${fecha}.log`);
function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(logFile, line);
    console.log(msg);
}

// Comandos que no son queries indexables (no tienen sentido para CREATE INDEX)
const NO_INDEXABLE_PREFIX = /^\s*(SHOW|SET|START|COMMIT|ROLLBACK|BEGIN|EXPLAIN|DESC|DESCRIBE|USE|GRANT|FLUSH|ANALYZE|OPTIMIZE|LOCK|UNLOCK|CALL)\b/i;

// --------------------------------------------------------------------------
// Parsing heurístico del digest_text normalizado de MySQL (con "?" por literales)
// --------------------------------------------------------------------------

const SQL_KEYWORDS = /^(SELECT|WHERE|ON|VALUES|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|GROUP|ORDER|HAVING|LIMIT|SET|UNION|USING|AND|OR|AS)$/i;

// Quita backticks y colapsa "alias . columna" (con espacios, como lo normaliza
// performance_schema) a "alias.columna" para que el resto del parsing sea simple.
function normalizeSql(sql) {
    return sql
        .replace(/\s+/g, " ")
        .replace(/`/g, "")
        .replace(/(\w+)\s*\.\s*(\w+)/g, "$1.$2")
        .trim();
}

function extractTables(sql) {
    // Devuelve { alias_or_name: table_name }
    const map = {};
    const re = /\b(?:FROM|JOIN)\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?/gi;
    let m;
    while ((m = re.exec(sql)) !== null) {
        const table = m[1];
        let alias = m[2] || table;
        // Evita capturar palabras reservadas que sigan a FROM/JOIN por error de regex en subqueries simples
        if (SQL_KEYWORDS.test(table)) continue;
        if (SQL_KEYWORDS.test(alias)) alias = table;
        map[alias] = table;
        map[table] = table;
    }
    return map;
}

function resolveColumn(ref, tableMap, defaultTable) {
    // ref puede ser "alias.columna" o "columna"
    const parts = ref.split(".");
    if (parts.length === 2) {
        const [alias, col] = parts;
        const table = tableMap[alias];
        if (!table) return null;
        return { table, column: col };
    }
    if (!defaultTable) return null;
    return { table: defaultTable, column: ref };
}

function extractClause(sql, startKeyword, stopKeywords) {
    const stopPattern = stopKeywords.join("|");
    const re = new RegExp(`${startKeyword}\\s+(.*?)(?:\\b(?:${stopPattern})\\b|$)`, "is");
    const m = sql.match(re);
    return m ? m[1].trim() : "";
}

function analyzeQuery(digestText, tableMap) {
    // digestText ya debe venir normalizado (sin backticks, sin espacios en "alias.columna")
    const sql = digestText;
    const firstTable = Object.values(tableMap)[0] || null;

    const equalityCols = [];
    const rangeCols = [];
    const orderCols = [];
    const groupCols = [];

    const whereClause = extractClause(sql, "WHERE", ["GROUP BY", "ORDER BY", "LIMIT", "HAVING"]);
    if (whereClause) {
        // condiciones simples unidas por AND (ignora OR: demasiado ambiguo para indexar bien)
        whereClause.split(/\bAND\b/i).forEach((cond) => {
            let m;
            if ((m = cond.match(/([\w.]+)\s*(=|IN)\s*/i)) && !SQL_KEYWORDS.test(m[1].split(".").pop())) {
                const ref = resolveColumn(m[1], tableMap, firstTable);
                if (ref) equalityCols.push(ref);
            } else if ((m = cond.match(/([\w.]+)\s*(>=|<=|>|<|<>|!=|LIKE)\s*/i)) && !SQL_KEYWORDS.test(m[1].split(".").pop())) {
                const ref = resolveColumn(m[1], tableMap, firstTable);
                if (ref) rangeCols.push(ref);
            }
        });
    }

    const onClause = sql.match(/\bON\s+([\w.]+)\s*=\s*([\w.]+)/gi) || [];
    onClause.forEach((c) => {
        const m = c.match(/\bON\s+([\w.]+)\s*=\s*([\w.]+)/i);
        if (m) {
            const left = resolveColumn(m[1], tableMap, null);
            const right = resolveColumn(m[2], tableMap, null);
            // ambos lados del JOIN suelen beneficiarse de índice si no son ya PK/FK indexada
            if (left) equalityCols.push(left);
            if (right) equalityCols.push(right);
        }
    });

    const orderClause = extractClause(sql, "ORDER BY", ["LIMIT"]);
    if (orderClause) {
        orderClause.split(",").forEach((c) => {
            const col = c.trim().split(/\s+/)[0];
            const ref = resolveColumn(col, tableMap, firstTable);
            if (ref) orderCols.push(ref);
        });
    }

    const groupClause = extractClause(sql, "GROUP BY", ["ORDER BY", "LIMIT", "HAVING"]);
    if (groupClause) {
        groupClause.split(",").forEach((c) => {
            const col = c.trim();
            const ref = resolveColumn(col, tableMap, firstTable);
            if (ref) groupCols.push(ref);
        });
    }

    return { equalityCols, rangeCols, orderCols, groupCols };
}

function dedupeRefs(refs) {
    const seen = new Set();
    const out = [];
    for (const r of refs) {
        const key = `${r.table}.${r.column}`;
        if (!seen.has(key)) {
            seen.add(key);
            out.push(r);
        }
    }
    return out;
}

// Agrupa columnas candidatas por tabla y propone UNA sola lista ordenada
// (igualdad primero, luego un rango/orden/group) — regla estándar de indexación.
function buildIndexProposalsPerTable(analysis) {
    const byTable = {};
    const allEq = dedupeRefs(analysis.equalityCols);
    const allRange = dedupeRefs([...analysis.rangeCols, ...analysis.orderCols, ...analysis.groupCols]);

    allEq.forEach((r) => {
        byTable[r.table] = byTable[r.table] || [];
        if (!byTable[r.table].includes(r.column)) byTable[r.table].push(r.column);
    });
    allRange.forEach((r) => {
        byTable[r.table] = byTable[r.table] || [];
        if (!byTable[r.table].includes(r.column)) byTable[r.table].push(r.column);
    });

    return byTable; // { tabla: [col1, col2, ...] }
}

// --------------------------------------------------------------------------

async function getExistingLeadingColumns(conn, dbName, tableNames) {
    if (!tableNames.length) return {};
    const [rows] = await conn.query(
        `SELECT TABLE_NAME AS tabla, COLUMN_NAME AS columna
         FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = ? AND SEQ_IN_INDEX = 1 AND TABLE_NAME IN (?)`,
        [dbName, tableNames]
    );
    const map = {};
    rows.forEach((r) => {
        map[r.tabla] = map[r.tabla] || new Set();
        map[r.tabla].add(r.columna.toLowerCase());
    });
    return map;
}

async function getFullScanQueries(conn) {
    const [rows] = await conn.query(
        `SELECT digest_text, count_star AS veces,
                ROUND(avg_timer_wait/1000000000,2) AS avg_seg,
                sum_rows_examined AS filas_examinadas,
                sum_no_index_used AS sin_indice
         FROM performance_schema.events_statements_summary_by_digest
         WHERE digest_text NOT LIKE '%performance_schema%'
           AND digest_text NOT LIKE '%information_schema%'
           AND sum_no_index_used > 0
         ORDER BY (count_star * avg_timer_wait) DESC
         LIMIT 30`
    );
    return rows;
}

function impactScore(row) {
    return Number(row.veces) * Number(row.avg_seg);
}

function priorityLabel(row) {
    const score = impactScore(row);
    if (Number(row.veces) >= 1000) return "ALTA (muy frecuente)";
    if (score >= 5000) return "ALTA (tiempo acumulado alto)";
    if (Number(row.avg_seg) >= 10) return "MEDIA-ALTA (queries lentas, baja frecuencia)";
    return "MEDIA";
}

function buildSqlOutput(recomendaciones, sinRecomendacion) {
    const lines = [];
    lines.push(`-- ============================================================`);
    lines.push(`-- Recomendaciones de índices — generado ${fecha}`);
    lines.push(`-- Basado en performance_schema.events_statements_summary_by_digest`);
    lines.push(`-- Estas son sugerencias heurísticas: REVISAR antes de ejecutar.`);
    lines.push(`-- No se ejecuta nada automáticamente.`);
    lines.push(`-- ============================================================\n`);

    recomendaciones.forEach((rec) => {
        lines.push(`-- ------------------------------------------------------------`);
        lines.push(`-- Tabla: ${rec.tabla}`);
        lines.push(`-- Prioridad: ${rec.prioridad}`);
        lines.push(`-- Impacto combinado: ${rec.veces} ejecuciones | avg ${rec.avg_seg}s | ${rec.filas_examinadas} filas examinadas`);
        if (rec.numQueries > 1) {
            lines.push(`-- Usado por ${rec.numQueries} queries distintas con full scan:`);
            (rec.queriesOrigen || [rec.queryOrigen]).forEach((q) => lines.push(`--   - ${q}`));
        } else {
            lines.push(`-- Query origen (digest): ${rec.queryOrigen}`);
        }
        lines.push(`-- Columnas propuestas: ${rec.columnas.join(", ")}`);
        lines.push(`-- ------------------------------------------------------------`);
        lines.push(`${rec.ddl}\n`);
    });

    if (sinRecomendacion.length) {
        lines.push(`-- ============================================================`);
        lines.push(`-- Queries con full scan SIN recomendación automática`);
        lines.push(`-- (requieren revisión manual: estructura compleja, CASE/MAX, o`);
        lines.push(`--  ya tienen índice cubriendo las columnas detectadas)`);
        lines.push(`-- ============================================================`);
        sinRecomendacion.forEach((r) => {
            lines.push(`-- [${r.veces}x, avg ${r.avg_seg}s, ${r.filas_examinadas} filas] ${r.digest_text}`);
        });
    }

    return lines.join("\n") + "\n";
}

function writeOutput(sql) {
    const datedFile = path.join(OUTPUT_DIR, `recomendaciones-indices-${fecha}.sql`);
    const latestFile = path.join(OUTPUT_DIR, `recomendaciones_ultimo.sql`);
    fs.writeFileSync(datedFile, sql, "utf8");
    fs.writeFileSync(latestFile, sql, "utf8");
    return { datedFile, latestFile };
}

async function main() {
    log("Iniciando análisis de queries con full scan...");
    log(`Credenciales leídas de: ${CONFIG_PATH}`);

    const conn = await mysql.createConnection({
        host: config.db.host,
        port: config.db.port,
        user: config.db.user,
        password: config.db.password,
        database: config.db.database,
    });

    try {
        const dbName = config.db.database;
        const rawRows = await getFullScanQueries(conn);

        const candidatas = rawRows.filter((r) => !NO_INDEXABLE_PREFIX.test(r.digest_text));
        log(`Queries con full scan: ${rawRows.length} totales, ${candidatas.length} indexables (excluidas SHOW/SET/etc.)`);

        const tablasInvolucradas = new Set();
        const analisisPorQuery = candidatas.map((row) => {
            const normalized = normalizeSql(row.digest_text);
            const tableMap = extractTables(normalized);
            const analysis = analyzeQuery(normalized, tableMap);
            Object.values(tableMap).forEach((t) => tablasInvolucradas.add(t));
            return { row, tableMap, analysis };
        });

        const existentes = await getExistingLeadingColumns(conn, dbName, [...tablasInvolucradas]);

        const recomendaciones = [];
        const sinRecomendacion = [];

        analisisPorQuery.forEach(({ row, analysis }) => {
            const porTabla = buildIndexProposalsPerTable(analysis);
            const tablas = Object.keys(porTabla);

            if (!tablas.length) {
                sinRecomendacion.push(row);
                return;
            }

            let algunaPropuesta = false;
            tablas.forEach((tabla) => {
                let cols = porTabla[tabla];
                const yaIndexadas = existentes[tabla] || new Set();
                // si la primera columna propuesta ya es columna líder de algún índice, se asume cubierta
                if (cols.length && yaIndexadas.has(cols[0].toLowerCase())) {
                    return;
                }
                cols = cols.slice(0, 3); // máx 3 columnas por índice propuesto (mantenerlo simple)
                const idxName = `idx_${tabla}_${cols.join("_")}`.slice(0, 64);
                const ddl = `CREATE INDEX \`${idxName}\` ON \`${tabla}\` (${cols.map((c) => `\`${c}\``).join(", ")});`;

                recomendaciones.push({
                    idxName,
                    tabla,
                    columnas: cols,
                    ddl,
                    veces: row.veces,
                    avg_seg: row.avg_seg,
                    filas_examinadas: row.filas_examinadas,
                    prioridad: priorityLabel(row),
                    queryOrigen: row.digest_text.replace(/\s+/g, " ").trim().slice(0, 150),
                });
                algunaPropuesta = true;
            });

            if (!algunaPropuesta) sinRecomendacion.push(row);
        });

        // Dedupe: varias queries distintas pueden tocar las mismas columnas de la
        // misma tabla y proponer el mismo índice — sin esto, el .sql trae el mismo
        // CREATE INDEX repetido y la 2da ejecución falla con "Duplicate key name".
        const porIndice = new Map();
        recomendaciones.forEach((rec) => {
            const key = rec.idxName;
            if (!porIndice.has(key)) {
                porIndice.set(key, {
                    ...rec,
                    veces: Number(rec.veces),
                    avg_seg: Number(rec.avg_seg),
                    filas_examinadas: Number(rec.filas_examinadas),
                    queriesOrigen: [rec.queryOrigen],
                    numQueries: 1,
                });
            } else {
                const acc = porIndice.get(key);
                acc.veces += Number(rec.veces);
                acc.avg_seg = Math.max(acc.avg_seg, Number(rec.avg_seg));
                acc.filas_examinadas += Number(rec.filas_examinadas);
                acc.numQueries += 1;
                if (!acc.queriesOrigen.includes(rec.queryOrigen)) acc.queriesOrigen.push(rec.queryOrigen);
                acc.prioridad = priorityLabel({ veces: acc.veces, avg_seg: acc.avg_seg });
            }
        });
        const recomendacionesUnicas = [...porIndice.values()];

        // ordenar por impacto descendente
        recomendacionesUnicas.sort((a, b) => impactScore(b) - impactScore(a));

        const sql = buildSqlOutput(recomendacionesUnicas, sinRecomendacion);
        const { datedFile, latestFile } = writeOutput(sql);

        log(`ANALISIS_OK — recomendaciones:${recomendacionesUnicas.length} (de ${recomendaciones.length} antes de deduplicar) sin_recomendacion:${sinRecomendacion.length}`);
        log(`Salida guardada en: ${datedFile}`);
        log(`(también actualizado: ${latestFile})`);
    } finally {
        await conn.end();
    }
}

main().catch((err) => {
    log(`ERROR: ${err.message}`);
    process.exit(1);
});
