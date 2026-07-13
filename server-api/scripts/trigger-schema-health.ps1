# Disparador delgado — Task Scheduler "Reporte Semanal MySQL" (ver 20-Proyecto/design-schema-monitor.md)
# Sin lógica propia: solo llama al endpoint, el cómputo vive en server-api/lib/schemaHealth.js

$config = Get-Content "C:\Users\InversionesWildaga\Documents\Claude-Cowork-Scripts\mysql_config.json" | ConvertFrom-Json

Invoke-RestMethod -Uri "http://localhost:8050/internal/reports/schema_health/run" `
    -Method Post `
    -Headers @{ "X-API-Key" = $config.api_key }
