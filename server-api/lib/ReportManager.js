// Dueño del dominio "reportes" — ver 20-Proyecto/design-report-center.md
// Cualquier módulo que genere un reporte (schemaHealth.js, futuros ibReconcile.js, ...) llama
// a registrar() al terminar; nunca reimplementa el INSERT/SELECT sobre reportes_historial.

async function registrar(pool, tipoReporte, categoria, referencia, reporte, tablasAfectadas = null) {
    const payload = Buffer.isBuffer(reporte) ? reporte : Buffer.from(JSON.stringify(reporte));

    const [activos] = await pool.query(
        `SELECT id FROM reportes_historial
         WHERE tipo_reporte = ? AND referencia = ? AND estado NOT IN ('resuelto', 'descartado')
         LIMIT 1`,
        [tipoReporte, referencia]
    );

    if (activos.length) {
        await pool.query(
            `UPDATE reportes_historial
             SET fecha_ejecucion = NOW(), categoria = ?, reporte = ?, tablas_afectadas = ?
             WHERE id = ?`,
            [categoria, payload, tablasAfectadas, activos[0].id]
        );
        return;
    }

    await pool.query(
        `INSERT INTO reportes_historial (tipo_reporte, fecha_ejecucion, categoria, referencia, reporte, estado, tablas_afectadas)
         VALUES (?, NOW(), ?, ?, ?, 'detectado', ?)`,
        [tipoReporte, categoria, referencia, payload, tablasAfectadas]
    );
}

async function ultimo(pool, tipoReporte) {
    const [rows] = await pool.query(
        `SELECT * FROM (
             SELECT id, tipo_reporte, fecha_ejecucion, categoria, referencia, reporte, estado,
                    tablas_afectadas, propuesta_correccion, fecha_resolucion,
                    ROW_NUMBER() OVER (PARTITION BY referencia ORDER BY fecha_ejecucion DESC) AS rn
             FROM reportes_historial
             WHERE tipo_reporte = ?
         ) t
         WHERE rn = 1 AND estado NOT IN ('resuelto', 'descartado')
         ORDER BY categoria, referencia`,
        [tipoReporte]
    );
    const parsed = rows.map(parseReporte);
    const maxFecha = parsed.reduce(
        (max, r) => (!max || r.fecha_ejecucion > max ? r.fecha_ejecucion : max),
        null
    );
    return parsed.map((r) => ({ ...r, no_reproducido: !!maxFecha && r.fecha_ejecucion < maxFecha }));
}

async function historico(pool, tipoReporte, referencia) {
    const [rows] = await pool.query(
        `SELECT id, tipo_reporte, fecha_ejecucion, categoria, referencia, reporte, estado,
                tablas_afectadas, propuesta_correccion, fecha_resolucion
         FROM reportes_historial
         WHERE tipo_reporte = ? AND referencia = ?
         ORDER BY fecha_ejecucion DESC`,
        [tipoReporte, referencia]
    );
    return rows.map(parseReporte);
}

async function marcarResuelto(pool, id, propuestaCorreccion) {
    await pool.query(
        `UPDATE reportes_historial
         SET estado = 'resuelto', propuesta_correccion = ?, fecha_resolucion = NOW()
         WHERE id = ?`,
        [propuestaCorreccion || null, id]
    );
}

async function marcarPropuesto(pool, id) {
    await pool.query(`UPDATE reportes_historial SET estado = 'propuesto' WHERE id = ?`, [id]);
}

function parseReporte(row) {
    try {
        return { ...row, reporte: JSON.parse(row.reporte.toString("utf8")) };
    } catch {
        return row;
    }
}

module.exports = { registrar, ultimo, historico, marcarResuelto, marcarPropuesto };
