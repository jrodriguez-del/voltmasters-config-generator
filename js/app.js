/**
 * app.js — Orquestador principal (Generador de Configuración Voltmasters)
 * 
 * Pipeline modular: parseo → análisis → JSON intermedio (GAP 7) → renderizado
 * 
 * Módulos:
 *   analyzer.js  — Motor matemático (4 análisis)
 *   rules.js     — Reglas de negocio (traducción ROI → VM)
 *   renderer.js  — Renderizado HTML (consume JSON intermedio)
 */

import { deriveBaseConfig, generateAlerts } from './rules.js';
import { analyzeMonthly, analyzePeriods, analyzeReserveNeeds, generateCalendar, generateScheduleChanges, analyzeImportLimit } from './analyzer.js';
import { renderReport, getReportCSS } from './renderer.js';


// ═════════════════════════════════════════════
// STATE
// ═════════════════════════════════════════════
const state = { simConfig: null, payload: null, csvRows: null, facturacionRows: null };


// ═════════════════════════════════════════════
// CSV PARSER
// ═════════════════════════════════════════════

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(';').map(h => h.trim().replace(/^"|"$/g, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(';');
    if (vals.length < headers.length) continue;
    const row = {};
    headers.forEach((h, idx) => {
      let v = (vals[idx] || '').trim().replace(/^"|"$/g, '');
      if (h !== 'Fecha' && h !== 'Periodo') { v = parseFloat(v.replace(',', '.')) || 0; }
      row[h] = v;
    });
    const parts = String(row.Fecha).match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
    if (parts) { row._month = +parts[2]; row._hour = +parts[4]; row._day = +parts[1]; }
    rows.push(row);
  }
  return rows;
}


// ═════════════════════════════════════════════
// PIPELINE: GENERATE JSON INTERMEDIATE (GAP 7)
// ═════════════════════════════════════════════

function extractPeajesCargosFromBilling(facturacionRows) {
  if (!facturacionRows || facturacionRows.length === 0) return null;

  // Group by period, take first non-zero value for each
  const peajes = {};
  const cargos = {};
  for (const row of facturacionRows) {
    const p = row.Periodo;
    if (!p || !p.startsWith('P')) continue;
    if (peajes[p] === undefined) {
      peajes[p] = row.Peaje_Energia_EUR_kWh || 0;
      cargos[p] = row.Cargo_Energia_EUR_kWh || 0;
    }
  }
  if (Object.keys(peajes).length === 0) return null;
  return { peajes, cargos };
}


function generateIntermediateJSON(simConfig, payload, csvRows, facturacionRows) {
  // 0. Extract peajes/cargos from billing CSV (most accurate source)
  const billingATR = extractPeajesCargosFromBilling(facturacionRows);
  if (billingATR) {
    // Inject into simConfig so deriveFixedPrices can use them
    if (!simConfig.contrato_electrico) simConfig.contrato_electrico = {};
    simConfig.contrato_electrico.peajes_energia = billingATR.peajes;
    simConfig.contrato_electrico.cargos_energia = billingATR.cargos;
  }

  // 1. Rules: derive base config
  const baseConfig = deriveBaseConfig(simConfig, payload);

  // 2. Analysis (if CSV available)
  let monthly = [], calendar = [], periodData = [], reserveData = [];
  let scheduleData = { transitions: [], changes: [] };

  if (csvRows && csvRows.length > 0) {
    const capUtil = baseConfig.bateria_util_kwh || baseConfig.bateria_kwh * 0.8;
    const batteryConfig = {
      capacidad_kwh: simConfig.bateria?.capacidad_kwh || 0,
      soc_min_pct: simConfig.bateria?.soc_min_pct || 10,
    };

    monthly = analyzeMonthly(csvRows, capUtil);
    calendar = generateCalendar(monthly, baseConfig);
    periodData = analyzePeriods(csvRows);
    reserveData = analyzeReserveNeeds(csvRows, capUtil, batteryConfig);

    // Análisis 5: Import limit basado en curvas reales
    const importLimitFromCurves = analyzeImportLimit(csvRows, {
      capacidad_kwh: simConfig.bateria?.capacidad_kwh || 0,
      soc_min_pct: simConfig.bateria?.soc_min_pct || 10,
    });
    if (importLimitFromCurves) {
      baseConfig.vm_import_limit = importLimitFromCurves.recommendation;
      baseConfig.vm_import_limit_from_curves = true;
      baseConfig.vm_import_limit_analysis = importLimitFromCurves;
      baseConfig.vm_import_limit_reason = `Basado en an\u00e1lisis de ${importLimitFromCurves.effectiveEvents} eventos de peak shaving con SoC disponible. `
        + `La bater\u00eda mantiene el pico por debajo de ${importLimitFromCurves.effective_p90} kW el 90% del tiempo `
        + `y por debajo de ${importLimitFromCurves.effective_p95} kW el 95% del tiempo.`;
      baseConfig.vm_import_limit_warning = false; // Data-driven = confident
    }
  }

  // 3. Schedule changes (CNMC)
  const pc = baseConfig.pc_override || baseConfig.potencias_optimas;
  scheduleData = generateScheduleChanges(pc);

  // 4. Alerts (GAP 3 + Problemas 1,4,6)
  const alerts = generateAlerts(simConfig, payload, baseConfig);

  // 5. Assemble JSON intermediate
  return {
    meta: {
      nombre: baseConfig.nombre,
      tarifa: baseConfig.tarifa,
      tension: baseConfig.tension_contador,
      ahorro_total_eur: baseConfig.ahorro_eur,
      pct_ahorro: baseConfig.pct_ahorro,
      bateria_modelo: baseConfig.bateria_modelo,
      bateria_unidades: baseConfig.bateria_unidades,
      generado: new Date().toISOString(),
    },
    baseConfig,
    monthly,
    calendar,
    periodData,
    reserveData,
    scheduleData,
    importLimitAnalysis: baseConfig.vm_import_limit_analysis || null,
    alerts,
  };
}


// ═════════════════════════════════════════════
// PROCESS DATA & RENDER
// ═════════════════════════════════════════════

function processData() {
  if (!state.simConfig) return;

  // Generate JSON intermediate (GAP 7)
  const jsonData = generateIntermediateJSON(state.simConfig, state.payload, state.csvRows, state.facturacionRows);

  // Log JSON intermediate for debugging / future API use
  console.log('[GAP 7] JSON intermedio generado:', jsonData);

  // Render report HTML
  const reportBody = renderReport(jsonData);
  const fullHTML = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Configuraci\u00f3n Voltmasters \u2014 ${jsonData.baseConfig.nombre}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<style>${getReportCSS()}</style></head><body>
<div class="container">${reportBody}</div>
<button class="print-btn" onclick="window.print()">🖨️ Imprimir</button></body></html>`;

  // Show in preview
  const preview = document.getElementById('report-preview');
  preview.srcdoc = fullHTML;
  preview.style.display = '';
  document.getElementById('zone-preview').style.display = '';

  // Enable download
  const btnDownload = document.getElementById('btn-download');
  btnDownload.disabled = false;
  btnDownload.onclick = () => {
    const safeName = (jsonData.baseConfig.nombre || 'proyecto').replace(/[^a-zA-Z0-9\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1_-]/g, '_').substring(0, 60);
    const blob = new Blob([fullHTML], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `config_voltmasters_${safeName}.html`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  };

  // Enable JSON download
  const btnJson = document.getElementById('btn-json');
  if (btnJson) {
    btnJson.disabled = false;
    btnJson.onclick = () => {
      const safeName = (jsonData.baseConfig.nombre || 'proyecto').replace(/[^a-zA-Z0-9\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1_-]/g, '_').substring(0, 60);
      const blob = new Blob([JSON.stringify(jsonData, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `config_voltmasters_${safeName}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    };
  }
}


// ═════════════════════════════════════════════
// FILE HANDLING
// ═════════════════════════════════════════════

async function handleFiles(files) {
  const fileList = Array.from(files);
  let loaded = [];
  for (const file of fileList) {
    const name = file.name.toLowerCase();
    if (name.includes('configuracion_simulacion') && name.endsWith('.json')) {
      state.simConfig = JSON.parse(await file.text()); loaded.push('✅ configuracion_simulacion.json');
    } else if (name.includes('cavo_payload') && name.endsWith('.json')) {
      state.payload = JSON.parse(await file.text()); loaded.push('✅ cavo_payload_b2b.json');
    } else if (name.includes('cavo_curvas_netted_bess') && name.endsWith('.csv')) {
      state.csvRows = parseCSV(await file.text()); loaded.push(`✅ Curvas CSV (${state.csvRows.length.toLocaleString()} filas)`);
    } else if (name.includes('cavo_facturacion') && name.endsWith('.csv')) {
      state.facturacionRows = parseCSV(await file.text()); loaded.push(`✅ Facturaci\u00f3n CSV (peajes y cargos)`);
    }
  }
  if (loaded.length > 0) {
    document.getElementById('upload-status').innerHTML = loaded.join('<br>');
    document.getElementById('upload-status').className = 'status status-ok';
    document.getElementById('upload-status').style.display = '';
    processData();
  } else {
    document.getElementById('upload-status').innerHTML = '⚠️ No se encontraron archivos reconocidos.';
    document.getElementById('upload-status').className = 'status status-warn';
    document.getElementById('upload-status').style.display = '';
  }
}


// ═════════════════════════════════════════════
// INIT
// ═════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  const drop = document.getElementById('drop-zone');
  const statusEl = document.getElementById('upload-status');

  // Drag & drop
  drop.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); drop.classList.add('drag-over'); });
  drop.addEventListener('dragleave', e => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('drag-over'); });
  drop.addEventListener('drop', async e => {
    e.preventDefault(); e.stopPropagation(); drop.classList.remove('drag-over');
    statusEl.innerHTML = '⌛ Escaneando archivos...';
    statusEl.className = 'status status-ok';
    statusEl.style.display = '';

    const files = [];
    const items = e.dataTransfer.items;
    if (items && items.length > 0) {
      const entries = [];
      for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry ? items[i].webkitGetAsEntry() : null;
        if (entry) entries.push(entry);
      }
      for (const entry of entries) {
        if (entry.isDirectory) {
          await readDirRecursive(entry, files);
        } else if (entry.isFile) {
          const file = await entryToFile(entry);
          if (file) files.push(file);
        }
      }
    }

    if (files.length === 0 && e.dataTransfer.files.length > 0) {
      for (const f of e.dataTransfer.files) files.push(f);
    }

    console.log(`[drop] Found ${files.length} files:`, files.map(f => f.name));
    if (files.length > 0) {
      handleFiles(files);
    } else {
      statusEl.innerHTML = '⚠️ No se pudieron leer los archivos. Usa el bot\u00f3n "Seleccionar carpeta" como alternativa.';
      statusEl.className = 'status status-warn';
    }
  });

  // File input (individual files)
  document.getElementById('file-input').addEventListener('change', e => handleFiles(e.target.files));

  // Folder input (webkitdirectory)
  document.getElementById('folder-input').addEventListener('change', e => handleFiles(e.target.files));
});


// ═════════════════════════════════════════════
// FILE SYSTEM HELPERS
// ═════════════════════════════════════════════

function entryToFile(fileEntry) {
  return new Promise(resolve => {
    fileEntry.file(f => resolve(f), () => resolve(null));
  });
}

function readAllEntries(reader) {
  return new Promise((resolve, reject) => {
    const allEntries = [];
    function readBatch() {
      reader.readEntries(entries => {
        if (entries.length === 0) { resolve(allEntries); }
        else { allEntries.push(...entries); readBatch(); }
      }, reject);
    }
    readBatch();
  });
}

async function readDirRecursive(dirEntry, fileList) {
  const reader = dirEntry.createReader();
  const entries = await readAllEntries(reader);
  for (const entry of entries) {
    if (entry.isFile) {
      const file = await entryToFile(entry);
      if (file) fileList.push(file);
    } else if (entry.isDirectory) {
      await readDirRecursive(entry, fileList);
    }
  }
}
