/**
 * analyzer.js — Motor matemático para análisis de curvas de batería
 * 
 * Procesa las 35.039 filas del CSV y extrae métricas para:
 *   Análisis 1: Métricas agregadas por mes natural (12 meses)
 *   Análisis 2: Comportamiento por periodo tarifario (P1-P6)
 *   Análisis 3: Peak Shaving Reserve (con SoC directo — GAP 1 resuelto)
 *   Análisis 4: Calendario filtrado de transiciones CNMC
 */

const MNAMES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

// ═══════════════════════════════════════════
// ANÁLISIS 1: MÉTRICAS MENSUALES
// ═══════════════════════════════════════════

export function analyzeMonthly(rows, capUtil) {
  const m = {};
  for (let i = 1; i <= 12; i++) {
    m[i] = {
      carga: 0, descarga: 0, cargaFV: 0, cargaRed: 0,
      picoSQ: 0, picoBESS: 0, importSQ: 0, importBESS: 0,
      exportBESS: 0, demanda: 0,
      preciosCarga: [], preciosDescarga: [],
      hCharge: new Array(24).fill(0),
      hDischarge: new Array(24).fill(0),
      count: 0,
    };
  }

  for (const r of rows) {
    if (!r._month) continue;
    const d = m[r._month];
    d.count++;
    d.carga += r.BESS_Carga_Neta_kWh || 0;
    d.descarga += r.BESS_Descarga_Neta_kWh || 0;
    d.cargaFV += r.BESS_Carga_Desde_FV_kWh || 0;
    d.cargaRed += r.BESS_Carga_Desde_Red_kWh || 0;
    d.picoSQ = Math.max(d.picoSQ, r.Pico_Red_SQ_kW || 0);
    d.picoBESS = Math.max(d.picoBESS, r.Pico_Red_BESS_kW || 0);
    d.importSQ += r.Import_Red_SQ_kWh || 0;
    d.importBESS += r.Import_Red_BESS_kWh || 0;
    d.exportBESS += r.Export_Red_BESS_kWh || 0;
    d.demanda += r.Demanda_Bruta_Edificio_kWh || 0;
    if ((r.BESS_Carga_Neta_kWh || 0) > 0) {
      d.preciosCarga.push(r.Precio_Energia_EUR_kWh || 0);
      d.hCharge[r._hour] += r.BESS_Carga_Neta_kWh;
    }
    if ((r.BESS_Descarga_Neta_kWh || 0) > 0) {
      d.preciosDescarga.push(r.Precio_Energia_EUR_kWh || 0);
      d.hDischarge[r._hour] += r.BESS_Descarga_Neta_kWh;
    }
  }

  const results = [];
  for (let i = 1; i <= 12; i++) {
    const d = m[i];
    if (d.count === 0) continue;
    const tot = d.cargaFV + d.cargaRed;
    const pctFV = tot > 0 ? d.cargaFV / tot * 100 : 0;
    const pctRed = tot > 0 ? d.cargaRed / tot * 100 : 0;
    const reduccion = d.picoSQ > 0 ? (d.picoSQ - d.picoBESS) / d.picoSQ * 100 : 0;
    const avgC = d.preciosCarga.length ? d.preciosCarga.reduce((a, b) => a + b, 0) / d.preciosCarga.length : 0;
    const avgD = d.preciosDescarga.length ? d.preciosDescarga.reduce((a, b) => a + b, 0) / d.preciosDescarga.length : 0;
    const spread = avgD - avgC;
    const ciclos = capUtil > 0 ? d.descarga / capUtil : 0;

    // Top hours by energy volume
    const chargeHours = d.hCharge.map((v, h) => ({ h, v })).filter(x => x.v > 0).sort((a, b) => b.v - a.v).slice(0, 4);
    const dischargeHours = d.hDischarge.map((v, h) => ({ h, v })).filter(x => x.v > 0).sort((a, b) => b.v - a.v).slice(0, 4);

    // Operation type classification
    let tipo, color;
    if (pctFV >= 60) { tipo = 'Autoconsumo FV'; color = '#059669'; }
    else if (pctRed >= 50 && spread > 0.01) { tipo = 'Arbitraje'; color = '#d97706'; }
    else { tipo = 'Mixto'; color = '#2563eb'; }

    results.push({
      month: i, name: MNAMES[i - 1], tipo, color, pctFV, pctRed,
      picoSQ: d.picoSQ, picoBESS: d.picoBESS,
      reduccion, avgPrecioCarga: avgC, avgPrecioDescarga: avgD, spread, ciclos,
      cargaTotal: d.carga, descargaTotal: d.descarga,
      importSQ: d.importSQ, importBESS: d.importBESS,
      chargeHours, dischargeHours,
      hCharge: d.hCharge, hDischarge: d.hDischarge,
    });
  }
  return results;
}


// ═══════════════════════════════════════════
// ANÁLISIS 2: COMPORTAMIENTO POR PERIODO (P1-P6)
// ═══════════════════════════════════════════

export function analyzePeriods(rows) {
  const periods = {};
  for (const r of rows) {
    const p = (r.Periodo || '').trim();
    if (!p.startsWith('P')) continue;
    if (!periods[p]) periods[p] = {
      count: 0, cargaFV: 0, cargaRed: 0, descarga: 0, carga: 0,
      picoSQ: 0, picoBESS: 0, picoCharge: 0, picoDischarge: 0,
      importSQ: 0, importBESS: 0, antivertido: 0,
      fvGen: 0, fvAuto: 0, fvExc: 0,
      precioSum: 0, precioMin: 999, precioMax: 0,
      hCarga: 0, hDescarga: 0, hIdle: 0,
      hourCharge: new Array(24).fill(0),
      hourDischarge: new Array(24).fill(0),
    };
    const s = periods[p];
    s.count++;
    s.cargaFV += r.BESS_Carga_Desde_FV_kWh || 0;
    s.cargaRed += r.BESS_Carga_Desde_Red_kWh || 0;
    s.carga += r.BESS_Carga_Neta_kWh || 0;
    s.descarga += r.BESS_Descarga_Neta_kWh || 0;
    s.picoSQ = Math.max(s.picoSQ, r.Pico_Red_SQ_kW || 0);
    s.picoBESS = Math.max(s.picoBESS, r.Pico_Red_BESS_kW || 0);
    s.picoCharge = Math.max(s.picoCharge, r.BESS_Carga_Neta_kW || 0);
    s.picoDischarge = Math.max(s.picoDischarge, r.BESS_Descarga_Neta_kW || 0);
    s.importSQ += r.Import_Red_SQ_kWh || 0;
    s.importBESS += r.Import_Red_BESS_kWh || 0;
    s.antivertido += r.Antivertido_kWh || 0;
    s.fvGen += r.FV_Gen_Teorica_Total_kWh || 0;
    s.fvAuto += r.FV_Autoconsumo_Total_kWh || 0;
    s.fvExc += r.FV_Excedentes_Total_kWh || 0;
    const precio = r.Precio_Energia_EUR_kWh || 0;
    s.precioSum += precio;
    s.precioMin = Math.min(s.precioMin, precio);
    s.precioMax = Math.max(s.precioMax, precio);
    if ((r.BESS_Carga_Neta_kWh || 0) > 0.01) s.hCarga++;
    else if ((r.BESS_Descarga_Neta_kWh || 0) > 0.01) s.hDescarga++;
    else s.hIdle++;
    const h = r._hour ?? 0;
    s.hourCharge[h] += r.BESS_Carga_Neta_kWh || 0;
    s.hourDischarge[h] += r.BESS_Descarga_Neta_kWh || 0;
  }

  const results = [];
  for (const p of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']) {
    const s = periods[p];
    if (!s || s.count === 0) continue;
    const hrs = s.count / 4; // 15-min intervals → hours
    const cargaTotal = s.cargaFV + s.cargaRed;
    const pctFV = cargaTotal > 0 ? s.cargaFV / cargaTotal * 100 : 0;
    const avgPrecio = s.precioSum / s.count;

    // Top charge/discharge hours
    const topCharge = s.hourCharge.map((v, h) => ({ h, v })).filter(x => x.v > 10).sort((a, b) => b.v - a.v).slice(0, 5);
    const topDischarge = s.hourDischarge.map((v, h) => ({ h, v })).filter(x => x.v > 10).sort((a, b) => b.v - a.v).slice(0, 5);

    // Behavior classification
    let behavior, behaviorColor;
    if (s.descarga > cargaTotal * 2) { behavior = 'DESCARGA'; behaviorColor = '#dc2626'; }
    else if (cargaTotal > s.descarga * 2) { behavior = 'CARGA'; behaviorColor = '#059669'; }
    else { behavior = 'MIXTO'; behaviorColor = '#d97706'; }

    // Detailed description
    let descripcion = '';
    if (behavior === 'DESCARGA') {
      descripcion = `La batería descarga ${Math.round(s.descarga)} kWh durante ${p}, cubriendo demanda en horas ${topDischarge.map(x => x.h + 'h').join(', ')}. `;
      if (s.picoSQ - s.picoBESS > 5) descripcion += `Recorta picos de ${Math.round(s.picoSQ)} → ${Math.round(s.picoBESS)} kW (Δ${Math.round(s.picoSQ - s.picoBESS)} kW). `;
      descripcion += `Precio medio: ${(avgPrecio * 1000).toFixed(1)} €/MWh.`;
    } else if (behavior === 'CARGA') {
      descripcion = `La batería carga ${Math.round(cargaTotal)} kWh (${Math.round(pctFV)}% FV, ${Math.round(100 - pctFV)}% red) en horas ${topCharge.map(x => x.h + 'h').join(', ')}. `;
      descripcion += `Precio medio: ${(avgPrecio * 1000).toFixed(1)} €/MWh.`;
    } else {
      descripcion = `Carga ${Math.round(cargaTotal)} kWh y descarga ${Math.round(s.descarga)} kWh. `;
      if (pctFV > 50) descripcion += `Carga mayoritariamente de FV (${Math.round(pctFV)}%). `;
      if (topCharge.length > 0) descripcion += `Carga: ${topCharge.map(x => x.h + 'h').join(',')}. `;
      if (topDischarge.length > 0) descripcion += `Descarga: ${topDischarge.map(x => x.h + 'h').join(',')}. `;
    }

    results.push({
      period: p, hours: Math.round(hrs), behavior, behaviorColor,
      cargaTotal: Math.round(cargaTotal), cargaFV: Math.round(s.cargaFV), cargaRed: Math.round(s.cargaRed),
      descarga: Math.round(s.descarga), pctFV: Math.round(pctFV),
      picoSQ: Math.round(s.picoSQ), picoBESS: Math.round(s.picoBESS),
      picoCharge: Math.round(s.picoCharge), picoDischarge: Math.round(s.picoDischarge),
      peakDelta: Math.round(s.picoSQ - s.picoBESS),
      avgPrecio, precioMin: s.precioMin, precioMax: s.precioMax,
      hCarga: Math.round(s.hCarga / 4), hDescarga: Math.round(s.hDescarga / 4), hIdle: Math.round(s.hIdle / 4),
      importDelta: Math.round(s.importSQ - s.importBESS),
      antivertido: Math.round(s.antivertido),
      topCharge, topDischarge, descripcion,
    });
  }
  return results;
}


// ═══════════════════════════════════════════
// ANÁLISIS 3: RESERVE ANALYSIS (Peak Shaving Reserve)
// GAP 1 resuelto: usa BESS_SoC_kWh directamente
// ═══════════════════════════════════════════

export function analyzeReserveNeeds(rows, capUtil, batteryConfig) {
  // batteryConfig = { capacidad_kwh, soc_min_pct } from simConfig.bateria
  const socMinAbs = batteryConfig
    ? (batteryConfig.soc_min_pct / 100) * batteryConfig.capacidad_kwh * 1.05
    : null; // 5% margin over SOC min

  const months = {};
  for (const r of rows) {
    if (!r._month) continue;
    const m = r._month, h = r._hour ?? 0;
    if (!months[m]) months[m] = {
      hCh: new Array(24).fill(0), hDis: new Array(24).fill(0),
      hPicoSQ: new Array(24).fill(0), hPicoBESS: new Array(24).fill(0),
      hImportSQ: new Array(24).fill(0), hImportBESS: new Array(24).fill(0),
      hCount: new Array(24).fill(0), dailys: {},
    };
    const mon = months[m];
    mon.hCh[h] += r.BESS_Carga_Neta_kWh || 0;
    mon.hDis[h] += r.BESS_Descarga_Neta_kWh || 0;
    mon.hPicoSQ[h] = Math.max(mon.hPicoSQ[h], r.Pico_Red_SQ_kW || 0);
    mon.hPicoBESS[h] = Math.max(mon.hPicoBESS[h], r.Pico_Red_BESS_kW || 0);
    mon.hImportSQ[h] += r.Import_Red_SQ_kWh || 0;
    mon.hImportBESS[h] += r.Import_Red_BESS_kWh || 0;
    mon.hCount[h]++;
    const dayKey = String(r._day).padStart(2, '0') + '/' + String(m).padStart(2, '0');
    if (!mon.dailys[dayKey]) mon.dailys[dayKey] = {
      ch: new Array(24).fill(0), dis: new Array(24).fill(0),
      peakSQ: 0, peakH: 0, socMin: Infinity,
    };
    const dp = mon.dailys[dayKey];
    dp.ch[h] += r.BESS_Carga_Neta_kWh || 0;
    dp.dis[h] += r.BESS_Descarga_Neta_kWh || 0;
    if ((r.Pico_Red_SQ_kW || 0) > dp.peakSQ) { dp.peakSQ = r.Pico_Red_SQ_kW; dp.peakH = h; }

    // GAP 1: Track real SoC minimum per day
    const soc = r.BESS_SoC_kWh;
    if (soc != null && !isNaN(soc) && soc < dp.socMin) {
      dp.socMin = soc;
    }
  }

  const results = [];
  for (let m = 1; m <= 12; m++) {
    const mon = months[m];
    if (!mon) continue;
    const maxSQ = Math.max(...mon.hPicoSQ);
    const maxBESS = Math.max(...mon.hPicoBESS);
    const peakDelta = maxSQ - maxBESS;
    const doesPS = peakDelta > 5;

    let morningDis = 0, afternoonDis = 0, nightCh = 0;
    for (let h = 6; h <= 12; h++) morningDis += mon.hDis[h];
    for (let h = 17; h <= 22; h++) afternoonDis += mon.hDis[h];
    for (let h = 0; h <= 7; h++) nightCh += mon.hCh[h];
    const doubleCycle = morningDis > 1000 && afternoonDis > 1000;

    const days = Object.values(mon.dailys);
    let emptyBefore = 0;
    for (const d of days) {
      let mDis = 0; for (let h = 6; h <= 12; h++) mDis += d.dis[h];
      let aDis = 0; for (let h = 13; h <= 22; h++) aDis += d.dis[h];

      // GAP 1: Use real SoC + heuristic double-check
      const heuristicEmpty = mDis > 50 && aDis < mDis * 0.15;
      const socEmpty = socMinAbs != null && d.socMin !== Infinity && d.socMin <= socMinAbs;

      // Count as "emptied" if EITHER real SoC confirms OR heuristic says so (fallback)
      if (socMinAbs != null) {
        // When SoC data available: require both conditions for higher accuracy
        if (socEmpty && heuristicEmpty) emptyBefore++;
      } else {
        // Fallback: original heuristic when SoC column not available
        if (heuristicEmpty) emptyBefore++;
      }
    }
    const riskPct = days.length > 0 ? Math.round(emptyBefore / days.length * 100) : 0;

    const gridCh = [];
    for (let h = 0; h < 24; h++) {
      if (mon.hImportBESS[h] > mon.hImportSQ[h] + 100) gridCh.push(h);
    }

    let type = 'OK', rec = '', reservePct = 0;
    const chHrs = mon.hCh.map((v, h) => ({ h, v })).filter(x => x.v > 500).sort((a, b) => b.v - a.v).slice(0, 4);
    const disHrs = mon.hDis.map((v, h) => ({ h, v })).filter(x => x.v > 500).sort((a, b) => b.v - a.v).slice(0, 4);

    if (riskPct > 20 && doesPS) {
      type = 'RESERVE';
      const psEnergy = peakDelta * 2;
      reservePct = capUtil > 0 ? Math.min(50, Math.ceil(psEnergy / capUtil * 100)) : 15;
      rec = 'La batería se vacía en ' + emptyBefore + '/' + days.length + ' días antes de los picos. Como hace peak shaving (' + Math.round(peakDelta) + ' kW), reservar ' + reservePct + '% de SOC.';
    } else if (doubleCycle && doesPS) {
      type = 'RESERVE';
      const psEnergy = peakDelta * 1.5;
      reservePct = capUtil > 0 ? Math.min(40, Math.ceil(psEnergy / capUtil * 100)) : 10;
      rec = 'Doble ciclo (mañana+tarde) con peak shaving (' + Math.round(peakDelta) + ' kW). Consumption Planning NO protege picos de potencia — solo Peak Shaving Reserve garantiza que la batería no se vacía. Reservar ' + reservePct + '% de SOC.';
    } else if (doubleCycle && !doesPS) {
      type = 'OK';
      rec = 'Doble ciclo (mañana+tarde) pero sin peak shaving. La batería solo hace arbitraje — no necesita reserva de SOC.';
    } else if (doesPS && gridCh.length > 0) {
      type = 'OK';
      rec = 'Recorta picos (' + Math.round(peakDelta) + ' kW) y se carga de red por la noche (' + gridCh.map(h => h + 'h').join(',') + '). La carga nocturna asegura energía para peak shaving. Reserve = 0%.';
    } else {
      type = 'OK';
      rec = 'No se vacía antes de los picos. Peak shaving reserve = 0% es correcto.';
    }

    results.push({
      month: m, name: MNAMES[m - 1], doesPS, peakDelta: Math.round(peakDelta),
      maxSQ: Math.round(maxSQ), maxBESS: Math.round(maxBESS),
      doubleCycle, morningDis: Math.round(morningDis), afternoonDis: Math.round(afternoonDis),
      emptyBefore, totalDays: days.length, riskPct,
      gridCh, chargeHrs: chHrs.map(x => x.h), dischargeHrs: disHrs.map(x => x.h),
      type, rec, reservePct,
    });
  }
  return results;
}


// ═══════════════════════════════════════════
// ANÁLISIS 4: CALENDARIO CNMC (FILTRADO)
// Resuelve Problema 2: eventos redundantes
// ═══════════════════════════════════════════

export function generateCalendar(monthly, baseConfig) {
  const pc = baseConfig.pc_override || baseConfig.potencias_optimas;
  const pcActual = baseConfig.potencias_actuales;

  const SEASONS = [
    { id: 'ALTA', months: [1, 2, 7, 12], period: 'P1', label: 'Temporada Alta', color: '#dc2626' },
    { id: 'MEDIA_ALTA', months: [3, 11], period: 'P2', label: 'Temporada Media-Alta', color: '#ea580c' },
    { id: 'MEDIA', months: [6, 8, 9], period: 'P3', label: 'Temporada Media', color: '#d97706' },
    { id: 'BAJA', months: [4, 5, 10], period: 'P4', label: 'Temporada Baja', color: '#059669' },
  ];

  const calendar = [];
  for (const season of SEASONS) {
    const seasonMonthly = monthly.filter(m => season.months.includes(m.month));
    if (seasonMonthly.length === 0) continue;

    const gridLimit = pc ? pc[season.period] : null;
    const currentPC = pcActual ? pcActual[season.period] : null;
    const maxPeakSQ = Math.max(...seasonMonthly.map(m => m.picoSQ));
    const maxPeakBESS = Math.max(...seasonMonthly.map(m => m.picoBESS));
    const avgPctFV = seasonMonthly.reduce((s, m) => s + m.pctFV, 0) / seasonMonthly.length;

    const allCharge = seasonMonthly.flatMap(m => m.chargeHours);
    const allDischarge = seasonMonthly.flatMap(m => m.dischargeHours);
    const topCharge = dedupeTopHours(allCharge);
    const topDischarge = dedupeTopHours(allDischarge);

    const chargeDesc = topCharge.map(x => `${x.h}h`).join(', ');
    const dischDesc = topDischarge.map(x => `${x.h}h`).join(', ');
    const description = `Carga: ${chargeDesc} (${avgPctFV.toFixed(0)}% FV / ${(100 - avgPctFV).toFixed(0)}% red). Descarga: ${dischDesc}. Pico SQ: ${Math.round(maxPeakSQ)} kW → con BESS: ${Math.round(maxPeakBESS)} kW.`;

    calendar.push({
      season: season.id, period: season.period, label: season.label, color: season.color,
      months: seasonMonthly.map(m => m.name).join(', '),
      gridLimit, currentPC,
      changed: currentPC && gridLimit && gridLimit !== currentPC,
      maxPeakSQ, maxPeakBESS, description,
      monthData: seasonMonthly,
    });
  }
  return calendar;
}

function dedupeTopHours(hourEntries) {
  const sums = {};
  for (const x of hourEntries) { sums[x.h] = (sums[x.h] || 0) + x.v; }
  return Object.entries(sums).map(([h, v]) => ({ h: +h, v })).sort((a, b) => b.v - a.v).slice(0, 4);
}


// ═══════════════════════════════════════════
// CNMC SCHEDULE TRANSITIONS (filtrado Problema 2)
// ═══════════════════════════════════════════

export function generateScheduleChanges(pc) {
  if (!pc) return { transitions: [], changes: [] };

  const cnmcTransitions = [
    { date: '1 Enero', period: 'P1', season: 'Temporada Alta (invierno)', months: 'Enero – Febrero' },
    { date: '1 Marzo', period: 'P2', season: 'Temporada Media-Alta', months: 'Marzo' },
    { date: '1 Abril', period: 'P4', season: 'Temporada Baja', months: 'Abril – Mayo' },
    { date: '1 Junio', period: 'P3', season: 'Temporada Media', months: 'Junio' },
    { date: '1 Julio', period: 'P1', season: 'Temporada Alta (verano)', months: 'Julio' },
    { date: '1 Agosto', period: 'P3', season: 'Temporada Media', months: 'Agosto – Septiembre' },
    { date: '1 Octubre', period: 'P4', season: 'Temporada Baja', months: 'Octubre' },
    { date: '1 Noviembre', period: 'P2', season: 'Temporada Media-Alta', months: 'Noviembre' },
    { date: '1 Diciembre', period: 'P1', season: 'Temporada Alta (invierno)', months: 'Diciembre' },
  ];

  cnmcTransitions.forEach(t => { t.gridLimit = pc[t.period]; });

  // Filter: only keep transitions where the limit actually changes
  const scheduleChanges = [];
  let lastLimit = null;
  cnmcTransitions.forEach(t => {
    if (t.gridLimit !== lastLimit) {
      scheduleChanges.push(t);
      lastLimit = t.gridLimit;
    }
  });

  return { transitions: cnmcTransitions, changes: scheduleChanges };
}


// ═══════════════════════════════════════════
// SPREAD VALIDATION (GAP 3)
// ═══════════════════════════════════════════

export function validateSpreadVsMinPriceDiff(baseConfig) {
  const alerts = [];

  if (baseConfig.fixed_prices) {
    const vals = Object.values(baseConfig.fixed_prices);
    const maxPrice = Math.max(...vals);
    const minPrice = Math.min(...vals);
    const spread = maxPrice - minPrice;
    const mpd = baseConfig.vm_min_price_diff;

    if (spread < mpd) {
      alerts.push({
        tipo: 'warning',
        codigo: 'SPREAD_BELOW_MPD',
        mensaje: `El spread real entre periodos (${spread.toFixed(1)} €/MWh = P máx ${maxPrice.toFixed(1)} − P mín ${minPrice.toFixed(1)}) es MENOR que el Minimum price difference configurado (${mpd} €/MWh). Voltmasters NO hará arbitraje porque nunca se supera el umbral. Considerar reducir el Minimum price difference.`,
      });
    }
  }

  return alerts;
}
