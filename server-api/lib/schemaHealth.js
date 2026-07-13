const config = require("C:/Users/InversionesWildaga/Documents/Claude-Cowork-Scripts/mysql_config.json");

async function getSchemaHealth(pool) {
    const dbName = config.db.database;

    const [tablas] = await pool.query(
        `SELECT TABLE_NAME AS tabla, TABLE_ROWS AS filas,
                ROUND(DATA_LENGTH/1024/1024,2) AS datos_mb,
                ROUND(INDEX_LENGTH/1024/1024,2) AS indices_mb,
                ROUND((DATA_LENGTH+INDEX_LENGTH)/1024/1024,2) AS total_mb
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
         ORDER BY (DATA_LENGTH+INDEX_LENGTH) DESC`,
        [dbName]
    );

    const [indices_sin_uso] = await pool.query(
        `SELECT object_name AS tabla, index_name AS indice,
                count_read AS lecturas, count_write AS escrituras
         FROM performance_schema.table_io_waits_summary_by_index_usage
         WHERE object_schema = ?
           AND index_name IS NOT NULL AND index_name != 'PRIMARY'
           AND count_read = 0 AND count_write = 0
         ORDER BY object_name`,
        [dbName]
    );

    const [full_scans] = await pool.query(
        `SELECT SUBSTRING(digest_text,1,80) AS query_text,
                query_sample_text,
                count_star AS veces,
                ROUND(avg_timer_wait/1000000000000,2) AS avg_seg,
                sum_rows_examined AS filas_examinadas,
                ROUND(sum_rows_examined / count_star) AS filas_examinadas_prom,
                sum_no_index_used AS sin_indice
         FROM performance_schema.events_statements_summary_by_digest
         WHERE digest_text NOT LIKE '%performance_schema%'
           AND digest_text NOT LIKE '%information_schema%'
           AND sum_no_index_used > 0
           AND sum_rows_examined / count_star >= 10000000
         ORDER BY filas_examinadas_prom DESC
         LIMIT 10`
    );

    const [[bpUso]] = await pool.query(
        `SELECT ROUND(variable_value/1024/1024/1024,2) AS gb
         FROM performance_schema.global_status
         WHERE variable_name = 'Innodb_buffer_pool_bytes_data'`
    );

    const [[bpConf]] = await pool.query(
        `SELECT ROUND(@@innodb_buffer_pool_size/1024/1024/1024,2) AS gb`
    );

    return {
        database: dbName,
        generado: new Date().toISOString(),
        tablas,
        indices_sin_uso,
        full_scans,
        buffer_pool: {
            en_uso_gb: bpUso ? bpUso.gb : null,
            configurado_gb: bpConf ? bpConf.gb : null,
        },
    };
}

async function getSlowQueries(pool, { table, minSeconds = 0, limit = 20 } = {}) {
    let sql = `SELECT SUBSTRING(digest_text,1,120) AS query_text,
                      count_star AS veces,
                      ROUND(avg_timer_wait/1000000000000,3) AS avg_seg,
                      ROUND(sum_timer_wait/1000000000000,2) AS total_seg,
                      sum_rows_examined AS filas_examinadas,
                      sum_no_index_used AS sin_indice
               FROM performance_schema.events_statements_summary_by_digest
               WHERE digest_text NOT LIKE '%performance_schema%'
                 AND digest_text NOT LIKE '%information_schema%'`;
    const params = [];
    if (table) {
        sql += " AND digest_text LIKE ?";
        params.push(`%${table}%`);
    }
    if (minSeconds > 0) {
        sql += " AND avg_timer_wait/1000000000000 >= ?";
        params.push(minSeconds);
    }
    sql += " ORDER BY avg_timer_wait DESC LIMIT ?";
    params.push(limit);

    const [rows] = await pool.query(sql, params);
    return rows;
}

async function resetStats(pool) {
    await pool.query("TRUNCATE TABLE performance_schema.events_statements_summary_by_digest");
}

module.exports = { getSchemaHealth, getSlowQueries, resetStats };
