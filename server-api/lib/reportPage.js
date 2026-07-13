// Página genérica de Report Center — misma UI para cualquier tipo_reporte (ver design-report-center.md)
// Reusa ReportManager.ultimo() / marcarResuelto() vía la ruta; este módulo solo arma el HTML.

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}

function renderPage(tipo, rows) {
    const filas = rows.map(renderFila).join("\n");
    const categorias = [...new Set(rows.map((r) => r.categoria))].sort();

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Report Center — ${escapeHtml(tipo)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: #0d1117; color: #e6edf3; font-family: -apple-system, Segoe UI, sans-serif; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  .sub { color: #8b949e; margin-bottom: 20px; font-size: 0.9rem; }
  select { background: #161b22; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 6px 10px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #21262d; font-size: 0.88rem; vertical-align: top; }
  th { color: #8b949e; font-weight: 600; text-transform: uppercase; font-size: 0.72rem; letter-spacing: 0.04em; }
  tr.row:hover { background: #161b22; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.75rem; }
  .badge.detectado { background: #4d2d00; color: #f0883e; }
  .badge.propuesto { background: #1c3a5e; color: #58a6ff; }
  .badge.ausente-tag { background: #1a2f1a; color: #3fb950; margin-left: 4px; }
  tr.row.ausente { opacity: 0.6; }
  .tablas { color: #79c0ff; font-family: monospace; font-size: 0.82rem; }
  .ref { font-family: monospace; font-size: 0.82rem; color: #c9d1d9; max-width: 420px; overflow-wrap: anywhere; }
  details summary { cursor: pointer; color: #58a6ff; font-size: 0.82rem; }
  pre { background: #010409; border: 1px solid #21262d; border-radius: 6px; padding: 10px; overflow-x: auto; font-size: 0.78rem; margin-top: 8px; }
  button { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 5px 10px; font-size: 0.8rem; cursor: pointer; }
  button:hover { background: #30363d; }
  .acciones { display: flex; gap: 6px; flex-wrap: wrap; }
  .vacio { color: #8b949e; padding: 40px 0; text-align: center; }
</style>
</head>
<body>
  <h1>Report Center — ${escapeHtml(tipo)}</h1>
  <div class="sub">${rows.length} hallazgo(s) activo(s)</div>

  <select id="filtroCategoria" onchange="filtrar()">
    <option value="">Todas las categorías</option>
    ${categorias.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("\n    ")}
  </select>

  ${rows.length === 0 ? '<div class="vacio">Sin hallazgos activos.</div>' : `
  <table>
    <thead>
      <tr><th>Categoría</th><th>Referencia</th><th>Tablas</th><th>Última corrida</th><th>Detalle</th><th>Acciones</th></tr>
    </thead>
    <tbody id="tbody">
      ${filas}
    </tbody>
  </table>`}

<script>
function filtrar() {
    const cat = document.getElementById('filtroCategoria').value;
    document.querySelectorAll('tr.row').forEach((tr) => {
        tr.style.display = (!cat || tr.dataset.categoria === cat) ? '' : 'none';
    });
}

async function marcarResuelto(id, tipo, sugerido) {
    const propuesta = prompt('Propuesta de corrección aplicada (opcional):', sugerido || '') || null;
    if (!confirm('¿Marcar este hallazgo como resuelto?')) return;
    const resp = await fetch('/reports/' + tipo + '/' + id + '/resolver', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propuesta_correccion: propuesta }),
    });
    if (resp.ok) {
        document.getElementById('fila-' + id).remove();
    } else {
        alert('Error al marcar resuelto');
    }
}

async function marcarDescartado(id, tipo, sugerido) {
    const nota = prompt('Nota (opcional) — por qué se descarta sin confirmar un fix:', sugerido || '') || null;
    if (!confirm('¿Descartar este hallazgo como no reproducido? No se marca como resuelto (no afirma que se corrigió) — solo se saca de la cola. Si el pipeline lo vuelve a detectar, reaparece fresco.')) return;
    const resp = await fetch('/reports/' + tipo + '/' + id + '/descartar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nota }),
    });
    if (resp.ok) {
        document.getElementById('fila-' + id).remove();
    } else {
        alert('Error al descartar');
    }
}

async function marcarPropuesto(id, tipo, btn) {
    if (!confirm('¿Marcar este hallazgo como pendiente de análisis? No se ejecuta nada automáticamente — queda a la espera de revisarlo en una sesión de Code.')) return;
    const resp = await fetch('/reports/' + tipo + '/' + id + '/proponer', { method: 'POST' });
    if (resp.ok) {
        btn.disabled = true;
        btn.textContent = 'En análisis';
        document.querySelector('#fila-' + id + ' .badge').classList.add('propuesto');
    } else {
        alert('Error al marcar para análisis');
    }
}

function copiarReferencia(texto) {
    navigator.clipboard.writeText(texto);
}
</script>
</body>
</html>`;
}

function renderFila(row) {
    const reporteJson = escapeHtml(JSON.stringify(row.reporte, null, 2));
    const sugerido = row.no_reproducido
        ? `No reprodujo en la corrida más reciente (última vez visto: ${new Date(row.fecha_ejecucion).toLocaleString("es-AR")})`
        : "";
    return `<tr class="row ${row.no_reproducido ? "ausente" : ""}" id="fila-${row.id}" data-categoria="${escapeHtml(row.categoria)}">
        <td><span class="badge ${escapeHtml(row.estado)}">${escapeHtml(row.categoria)}</span>${row.no_reproducido ? '<span class="badge ausente-tag">no reproducido</span>' : ""}</td>
        <td class="ref">${escapeHtml(row.referencia)}</td>
        <td class="tablas">${escapeHtml(row.tablas_afectadas || "—")}</td>
        <td>${new Date(row.fecha_ejecucion).toLocaleString("es-AR")}</td>
        <td><details><summary>Ver JSON</summary><pre>${reporteJson}</pre></details></td>
        <td class="acciones">
            <button onclick="copiarReferencia('${escapeHtml(row.referencia).replace(/'/g, "\\'")}')">Copiar ref.</button>
            ${row.estado === "propuesto"
                ? `<button disabled>En análisis</button>`
                : `<button onclick="marcarPropuesto(${row.id}, '${escapeHtml(row.tipo_reporte)}', this)">🔧 Proponer corrección</button>`}
            ${row.no_reproducido
                ? `<button onclick="marcarDescartado(${row.id}, '${escapeHtml(row.tipo_reporte)}', '${sugerido.replace(/'/g, "\\'")}')">Descartar (no reprodujo)</button>`
                : ""}
            <button onclick="marcarResuelto(${row.id}, '${escapeHtml(row.tipo_reporte)}', '${sugerido.replace(/'/g, "\\'")}')">Marcar resuelto</button>
        </td>
    </tr>`;
}

module.exports = { renderPage };
