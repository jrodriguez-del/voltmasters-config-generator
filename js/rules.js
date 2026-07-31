/**
 * rules.js — Motor de reglas: traduce datos de simulación ROI → configuración Voltmasters
 * 
 * Basado en documentación Voltmasters (76 fuentes NotebookLM)
 *
 * ROI formula: TE_i = A_i + B_i × OMIE_i  (cts €/kWh)
 *   A = costes fijos comercializador (cts €/kWh), label "A (cts)", default 0.50
 *   B = multiplicador sobre spot OMIE, label "B", default 1.05
 *
 * Voltmasters formula: precio_neto = scaling_factor × spot + consumption_cost
 *   scaling_factor ≈ B (promedio)
 *   consumption_cost ≈ A × 10 (cts/kWh → €/MWh)
 */


// ═══════════════════════════════════════════
// PEAJES Y CARGOS REGULADOS (energía, €/kWh)
// Fuente: CNMC Circular 3/2020 (peajes) + Orden TED (cargos)
// ⚠️ ACTUALIZAR ANUALMENTE con valores publicados en BOE
// ═══════════════════════════════════════════

const PEAJES_ENERGIA = {
  '3.0TD':  { P1: 0.013162, P2: 0.010435, P3: 0.006439, P4: 0.004532, P5: 0.002984, P6: 0.001932 },
  '6.1TD':  { P1: 0.007510, P2: 0.005612, P3: 0.003484, P4: 0.002459, P5: 0.001655, P6: 0.001073 },
  '6.2TD':  { P1: 0.005441, P2: 0.004064, P3: 0.002523, P4: 0.001781, P5: 0.001199, P6: 0.000777 },
  '6.3TD':  { P1: 0.003874, P2: 0.002893, P3: 0.001796, P4: 0.001268, P5: 0.000854, P6: 0.000553 },
  '6.4TD':  { P1: 0.002614, P2: 0.001952, P3: 0.001212, P4: 0.000856, P5: 0.000576, P6: 0.000373 },
};

const CARGOS_ENERGIA = {
  '3.0TD':  { P1: 0.019154, P2: 0.014470, P3: 0.006854, P4: 0.004416, P5: 0.002795, P6: 0.001460 },
  '6.1TD':  { P1: 0.015816, P2: 0.011973, P3: 0.005676, P4: 0.003660, P5: 0.002317, P6: 0.001210 },
  '6.2TD':  { P1: 0.011305, P2: 0.008558, P3: 0.004058, P4: 0.002616, P5: 0.001656, P6: 0.000865 },
  '6.3TD':  { P1: 0.008043, P2: 0.006088, P3: 0.002888, P4: 0.001861, P5: 0.001178, P6: 0.000615 },
  '6.4TD':  { P1: 0.005734, P2: 0.004341, P3: 0.002058, P4: 0.001326, P5: 0.000839, P6: 0.000438 },
};

function normalizeTarifa(raw) {
  if (!raw) return null;
  const t = raw.trim().toUpperCase().replace(/\s+/g, '').replace('.', '.');
  if (t.includes('3.0TD') || t.includes('30TD')) return '3.0TD';
  if (t.includes('6.1TD') || t.includes('61TD')) return '6.1TD';
  if (t.includes('6.2TD') || t.includes('62TD')) return '6.2TD';
  if (t.includes('6.3TD') || t.includes('63TD')) return '6.3TD';
  if (t.includes('6.4TD') || t.includes('64TD')) return '6.4TD';
  return null;
}


// ═══════════════════════════════════════════
// CONTRACT TYPE MAPPING
// ═══════════════════════════════════════════

export function deriveContractType(simConfig) {
  const tipo = (simConfig.contrato_electrico?.tipo_contrato || '').toUpperCase();
  const tarifa = (simConfig.suministro?.tarifa || '').trim().toUpperCase().replace(/\s/g, '');
  const isSpainTariff = ['3.0TD', '6.1TD', '6.2TD'].some(t => tarifa.includes(t));

  if (tipo.includes('PASS_THROUGH') || tipo.includes('PASSTHROUGH')) return 'Dynamic';
  if (tipo.includes('POOL') || tipo.includes('PASS_POOL') || tipo.includes('INDEXADO')) return 'Dynamic';
  if (tipo.includes('FIJO') || tipo.includes('FIXED')) {
    return isSpainTariff ? 'Fixed (Spain \u2014 time-of-use)' : 'Fixed';
  }
  return 'Dynamic';
}


// ═══════════════════════════════════════════
// STRATEGY DERIVATION
// ═══════════════════════════════════════════

export function deriveStrategy(simConfig) {
  const contractType = deriveContractType(simConfig);

  if (contractType === 'Fixed (Spain \u2014 time-of-use)') {
    const fijo = simConfig.contrato_electrico?.cfg_fijo;
    if (fijo) {
      const vals = Object.values(fijo);
      const allSame = vals.every(v => Math.abs(v - vals[0]) < 0.001);
      if (allSame) return 'Self-supply';
    }
  }

  const fvKwp = simConfig.fotovoltaica?.kwp || 0;
  if (fvKwp === 0 && contractType === 'Fixed') return 'Self-supply';

  return 'Cost optimization';
}


// ═══════════════════════════════════════════
// SCALING FACTORS (Dynamic contracts)
// ═══════════════════════════════════════════

export function deriveScalingFactors(simConfig) {
  const poolA = simConfig.contrato_electrico?.cfg_pool_a;
  const poolB = simConfig.contrato_electrico?.cfg_pool_b;
  if (!poolA || !poolB) return null;

  const periodsA = Object.values(poolA);
  const periodsB = Object.values(poolB);
  const avgA = periodsA.reduce((s, v) => s + v, 0) / periodsA.length;
  const avgB = periodsB.reduce((s, v) => s + v, 0) / periodsB.length;

  return {
    vm_scaling_factor: avgB,
    vm_consumption_cost_eur_mwh: avgA * 10,
    per_period: { A: poolA, B: poolB },
    note: `F\u00f3rmula ROI: TE = A + B\u00d7OMIE. A = costes fijos (cts/kWh), B = multiplicador spot. Voltmasters: scaling factor \u2248 ${avgB.toFixed(3)} (B), consumption cost \u2248 ${(avgA * 10).toFixed(1)} \u20ac/MWh (A\u00d710).`,
  };
}


// ═══════════════════════════════════════════
// FIXED CONTRACT PRICES (for Fixed Spain TOU)
// ⚠️ VOLTMASTERS NO SUMA PEAJES NI CARGOS
// Los precios deben incluir: Energía + Peajes + Cargos
// ═══════════════════════════════════════════

export function deriveFixedPrices(simConfig) {
  const fijo = simConfig.contrato_electrico?.cfg_fijo;
  if (!fijo) return null;

  const tarifa = normalizeTarifa(simConfig.suministro?.tarifa);

  const peajesSource = simConfig.contrato_electrico?.peajes_energia
    || simConfig.suministro?.peajes_energia
    || (tarifa && PEAJES_ENERGIA[tarifa])
    || null;

  const cargosSource = simConfig.contrato_electrico?.cargos_energia
    || simConfig.suministro?.cargos_energia
    || (tarifa && CARGOS_ENERGIA[tarifa])
    || null;

  const usesRegulated = !simConfig.contrato_electrico?.peajes_energia
    && !simConfig.suministro?.peajes_energia;

  const prices = {};
  const breakdown = {};

  for (const [p, v] of Object.entries(fijo)) {
    const energia = v;
    const peaje = peajesSource ? (peajesSource[p] || 0) : 0;
    const cargo = cargosSource ? (cargosSource[p] || 0) : 0;
    const total = energia + peaje + cargo;

    prices[p] = total * 1000;
    breakdown[p] = {
      energia: energia * 1000,
      peaje: peaje * 1000,
      cargo: cargo * 1000,
      total: total * 1000,
    };
  }

  return {
    prices,
    breakdown,
    tarifa,
    usesRegulated,
  };
}


// ═══════════════════════════════════════════
// PEAK SHAVING RESERVE DERIVATION
// ═══════════════════════════════════════════

export function derivePeakShavingReserve(simConfig, payload) {
  const pc = simConfig.optimizador_lp?.pc_override_kw || simConfig.suministro?.potencias_optimas_kw;
  const picoBESS = payload?.balance_energetico_anual_kwh?.pico_anual_bess_kw ?? 0;
  const potenciaKw = simConfig.bateria?.potencia_kw ?? 0;

  if (!pc) return { value: 0, reason: 'Sin potencias \u00f3ptimas \u2192 no se puede evaluar. Dejar en 0% y ajustar en campo.' };

  const minLimit = Math.min(...Object.values(pc));

  if (picoBESS > minLimit) {
    const overshoot = ((picoBESS - minLimit) / minLimit * 100).toFixed(0);
    const canCover = potenciaKw >= (picoBESS - minLimit);
    return {
      value: 25,
      reason: `Pico BESS (${Math.round(picoBESS)} kW) supera grid import limit m\u00ednimo (${minLimit} kW) en un ${overshoot}%. ${canCover ? 'La bater\u00eda tiene potencia suficiente para recortar.' : '\u26a0\ufe0f La bater\u00eda (' + potenciaKw + ' kW) NO tiene suficiente potencia para cubrir el exceso (' + Math.round(picoBESS - minLimit) + ' kW).'} Reservar 25% de SOC.`,
    };
  }

  return {
    value: 0,
    reason: `Pico BESS (${Math.round(picoBESS)} kW) \u2264 grid import limit m\u00ednimo (${minLimit} kW). Cost Optimization gestiona los picos sin necesidad de reserva.`,
  };
}


// ═══════════════════════════════════════════
// ALERTS GENERATOR (GAP 3 + Problemas 1,4,6)
// ═══════════════════════════════════════════

export function generateAlerts(simConfig, payload, baseConfig) {
  const alerts = [];

  const precioExcedentes = simConfig.contrato_electrico?.precio_excedentes_eur_kwh ?? 0;
  if (precioExcedentes > 0 && baseConfig.vm_contract_type === 'Fixed (Spain \u2014 time-of-use)') {
    alerts.push({
      tipo: 'warning', codigo: 'EXCEDENTES_CONFLICT',
      mensaje: `El cliente tiene un precio de excedentes pactado (${(precioExcedentes * 1000).toFixed(1)} \u20ac/MWh), pero Fixed Spain TOU bloquea la inyecci\u00f3n a 0 \u20ac/MWh. La bater\u00eda NO vender\u00e1 energ\u00eda proactivamente. En 6.1 TD priorizamos periodos P1-P6 sobre venta de excedentes.`,
    });
  }

  if (baseConfig.vm_contract_type === 'Dynamic' && baseConfig.scaling) {
    alerts.push({
      tipo: 'info', codigo: 'SCALING_AVERAGED',
      mensaje: `Contrato indexado. Voltmasters en modo Dynamic usa un \u00fanico Consumption cost para las 24h. Los peajes del ROI var\u00edan por periodo (P1-P6), pero aqu\u00ed se promedian. Puede afectar al arbitraje nocturno.`,
    });
  }

  const pc = simConfig.optimizador_lp?.pc_override_kw || simConfig.suministro?.potencias_optimas_kw;
  const picoBESS = payload?.balance_energetico_anual_kwh?.pico_anual_bess_kw ?? 0;
  const potenciaKw = simConfig.bateria?.potencia_kw ?? 0;
  if (pc) {
    const maxPot = Math.max(...Object.values(pc));
    if (picoBESS > maxPot) {
      alerts.push({
        tipo: 'warning', codigo: 'PICO_EXCEDE_LIMIT',
        mensaje: `La bater\u00eda (${potenciaKw} kW nominal) no tiene suficiente potencia para mantener el pico (${Math.round(picoBESS)} kW) por debajo del l\u00edmite contratado (${maxPot} kW). El peak shaving ser\u00e1 parcial.`,
      });
    }
  }

  if (baseConfig.fixed_prices) {
    const vals = Object.values(baseConfig.fixed_prices);
    const spread = Math.max(...vals) - Math.min(...vals);
    if (spread < baseConfig.vm_min_price_diff) {
      alerts.push({
        tipo: 'warning', codigo: 'SPREAD_BELOW_MPD',
        mensaje: `El spread entre periodos (${spread.toFixed(1)} \u20ac/MWh) es MENOR que Minimum price difference (${baseConfig.vm_min_price_diff} \u20ac/MWh). Voltmasters NO har\u00e1 arbitraje. Considerar reducir el MPD.`,
      });
    }
  }

  return alerts;
}


// ═══════════════════════════════════════════
// MAIN: DERIVE FULL BASE CONFIG
// ═══════════════════════════════════════════

export function deriveBaseConfig(simConfig, payload) {
  const contractType = deriveContractType(simConfig);
  const strategy = deriveStrategy(simConfig);
  const scaling = deriveScalingFactors(simConfig);
  const fixedPrices = deriveFixedPrices(simConfig);
  const peakReserve = derivePeakShavingReserve(simConfig, payload);

  const exportacion = payload?.balance_energetico_anual_kwh?.exportacion_red_bess ?? 0;
  const precioExcedentes = simConfig.contrato_electrico?.precio_excedentes_eur_kwh ?? 0;

  const tension = (simConfig.suministro?.tension_contador || '').toUpperCase();
  const maxPot = Math.max(...Object.values(simConfig.suministro?.potencias_actuales_kw || { P1: 0 }));
  const gridConnectionType = (tension === 'BT' && maxPot <= 15) ? 'Single-phase' : 'Three-phase';

  const hasExport = exportacion > 0 || precioExcedentes > 0;
  const batteryInjection = hasExport && contractType === 'Dynamic';
  const excedentesConflict = precioExcedentes > 0 && contractType === 'Fixed (Spain \u2014 time-of-use)';

  const pc = simConfig.optimizador_lp?.pc_override_kw || simConfig.suministro?.potencias_optimas_kw;
  const maxPC = pc ? Math.max(...Object.values(pc)) : 0;
  const minOptPower = pc ? Math.min(...Object.values(pc)) : null;
  const safetyMargin = minOptPower && minOptPower > 500 ? 15 : 10;

  const picoSQ = payload?.balance_energetico_anual_kwh?.pico_anual_sq_kw || 0;
  const picoBESS = payload?.balance_energetico_anual_kwh?.pico_anual_bess_kw || 0;
  const batteryPowerKW = simConfig.bateria?.potencia_kw || 0;
  const gapNeeded = picoSQ - maxPC;

  let vmImportLimit, vmImportLimitReason, vmImportLimitWarning = false;

  if (picoSQ > 0 && maxPC > 0 && gapNeeded > batteryPowerKW * 0.9) {
    vmImportLimit = Math.ceil(picoBESS > 0 ? picoBESS : picoSQ - batteryPowerKW);
    vmImportLimitWarning = true;
    vmImportLimitReason = `La bater\u00eda (${batteryPowerKW} kW) NO puede recortar el pico (${picoSQ} kW) hasta la PC (${maxPC} kW). `
      + `D\u00e9ficit: ${Math.round(gapNeeded - batteryPowerKW)} kW. `
      + `Si se pone ${maxPC} kW, Voltmasters descargar\u00e1 la bater\u00eda constantemente para un objetivo imposible, agot\u00e1ndola antes de los picos reales. `
      + `Import limit = ${vmImportLimit} kW (pico real con BESS de la simulaci\u00f3n).`;
  } else if (picoSQ > 0 && maxPC > 0 && gapNeeded > 0) {
    vmImportLimit = maxPC;
    vmImportLimitReason = `La bater\u00eda (${batteryPowerKW} kW) puede recortar el pico de ${picoSQ} kW a ~${picoBESS} kW, por debajo de ${maxPC} kW contratados.`;
  } else {
    vmImportLimit = maxPC || 0;
    vmImportLimitReason = 'Igual a potencia contratada.';
  }

  let minPriceDiff = 20;
  const fixedPriceValues = fixedPrices ? fixedPrices.prices : null;
  if (fixedPriceValues) {
    const vals = Object.values(fixedPriceValues);
    const spread = Math.max(...vals) - Math.min(...vals);
    minPriceDiff = Math.max(15, Math.round(spread * 0.5));
  }

  const config = {
    nombre: simConfig.nombre_simulacion || '',
    tarifa: simConfig.suministro?.tarifa || '',
    tipo_contrato_roi: simConfig.contrato_electrico?.tipo_contrato || '',
    tension_contador: tension,

    vm_contract_type: contractType,
    vm_control_strategy: strategy,

    vm_import_limit: vmImportLimit,
    vm_import_limit_reason: vmImportLimitReason,
    vm_import_limit_warning: vmImportLimitWarning,
    vm_grid_export_limit: exportacion === 0 ? 0 : null,
    vm_import_safety_margin: safetyMargin,
    pico_sq: picoSQ,
    pico_bess: picoBESS,

    vm_min_soc: simConfig.bateria?.soc_min_pct ?? 10,
    vm_max_soc: simConfig.bateria?.soc_max_pct ?? 90,
    vm_round_trip_eff: Math.round((simConfig.bateria?.eta_charge ?? 0.95) * (simConfig.bateria?.eta_discharge ?? 0.95) * 100),

    vm_min_price_diff: minPriceDiff,
    vm_battery_injection: batteryInjection,
    vm_grid_charging_injection: false,
    vm_excedentes_conflict: excedentesConflict,
    vm_scaling_is_averaged: contractType === 'Dynamic' && scaling !== null,
    vm_peak_shaving_reserve: peakReserve.value,
    vm_peak_shaving_reason: peakReserve.reason,
    vm_grey_zone: 0.5,
    vm_battery_load_balancing: (simConfig.bateria?.unidades || 1) > 1 ? 'Pro Rata' : null,
    vm_grid_connection_type: gridConnectionType,
    vm_pv_controllable: (simConfig.fotovoltaica?.kwp || 0) > 0,

    scaling: scaling,

    fixed_prices: fixedPriceValues,
    fixed_prices_breakdown: fixedPrices?.breakdown || null,
    fixed_prices_uses_regulated: fixedPrices?.usesRegulated ?? false,
    fixed_prices_tarifa: fixedPrices?.tarifa || null,

    potencias_actuales: simConfig.suministro?.potencias_actuales_kw || null,
    potencias_optimas: simConfig.suministro?.potencias_optimas_kw || null,
    pc_override: simConfig.optimizador_lp?.pc_override_kw || null,

    bateria_modelo: simConfig.bateria?.modelo || '',
    bateria_kwh: simConfig.bateria?.capacidad_kwh || 0,
    bateria_util_kwh: simConfig.bateria?.capacidad_util_kwh || 0,
    bateria_kw: simConfig.bateria?.potencia_kw || 0,
    bateria_unidades: simConfig.bateria?.unidades || 1,
    fv_kwp: simConfig.fotovoltaica?.kwp || 0,
    precio_excedentes: precioExcedentes,

    ahorro_fv: payload?.resultado?.optimizacion_fv?.ahorro_con_ie_eur ?? 0,
    ahorro_arbitraje: payload?.resultado?.arbitraje?.ahorro_con_ie_eur ?? 0,
    ahorro_peak_shaving: (payload?.resultado?.peak_shaving?.ahorro_potencia_con_ie_eur ?? 0) + (payload?.resultado?.peak_shaving?.ahorro_excesos_eur ?? 0),
    ahorro_fv_desc: payload?.resultado?.optimizacion_fv?.descripcion ?? '',
    ahorro_arb_desc: payload?.resultado?.arbitraje?.descripcion ?? '',
    ahorro_ps_desc: payload?.resultado?.peak_shaving?.descripcion ?? '',

    ahorro_eur: payload?.resultado?.ahorro_total_eur || simConfig.resultados?.ahorro_total_eur || 0,
    pct_ahorro: payload?.resultado?.pct_ahorro || simConfig.resultados?.pct_ahorro || 0,
    ciclos_anuales: payload?.bateria?.ciclos_anuales || simConfig.resultados?.ciclos_anuales || 0,
  };

  return config;
}


// ═══════════════════════════════════════════
// SPAIN TOU PERIODS (CNMC 3/2020)
// ═══════════════════════════════════════════

const SEASON_MAP = { 1: 'ALTA', 2: 'ALTA', 3: 'MEDIA_ALTA', 4: 'BAJA', 5: 'BAJA', 6: 'MEDIA', 7: 'ALTA', 8: 'MEDIA', 9: 'MEDIA', 10: 'BAJA', 11: 'MEDIA_ALTA', 12: 'ALTA' };
const SEASON_PERIODS = { 'ALTA': { peak: 'P1', shoulder: 'P2' }, 'MEDIA_ALTA': { peak: 'P2', shoulder: 'P3' }, 'MEDIA': { peak: 'P3', shoulder: 'P4' }, 'BAJA': { peak: 'P4', shoulder: 'P5' } };
const SEASON_LABELS = { 'ALTA': 'Alta (Ene,Feb,Jul,Dic)', 'MEDIA_ALTA': 'Media-alta (Mar,Nov)', 'MEDIA': 'Media (Jun,Ago,Sep)', 'BAJA': 'Baja (Abr,May,Oct)' };
const SPAIN_HOLIDAYS = ['01-01', '01-06', '05-01', '08-15', '10-12', '11-01', '12-06', '12-08', '12-25'];

export function getSpainPeriod(month, hour, isWeekendOrHoliday) {
  if (isWeekendOrHoliday || hour < 8) return 'P6';
  const s = SEASON_PERIODS[SEASON_MAP[month]];
  if ((hour >= 9 && hour < 14) || (hour >= 18 && hour < 22)) return s.peak;
  return s.shoulder;
}

export { SEASON_MAP, SEASON_PERIODS, SEASON_LABELS, SPAIN_HOLIDAYS };
