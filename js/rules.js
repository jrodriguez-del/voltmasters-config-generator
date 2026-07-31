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
// CONTRACT TYPE MAPPING
// ═══════════════════════════════════════════

export function deriveContractType(simConfig) {
  const tipo = (simConfig.contrato_electrico?.tipo_contrato || '').toUpperCase();
  const tarifa = (simConfig.suministro?.tarifa || '').trim().toUpperCase().replace(/\s/g, '');
  const isSpainTariff = ['3.0TD', '6.1TD', '6.2TD'].some(t => tarifa.includes(t));

  if (tipo.includes('PASS_THROUGH') || tipo.includes('PASSTHROUGH')) return 'Dynamic';
  if (tipo.includes('POOL') || tipo.includes('PASS_POOL') || tipo.includes('INDEXADO')) return 'Dynamic';
  if (tipo.includes('FIJO') || tipo.includes('FIXED')) {
    // AUDIT 1.1 / Problema 1: Fixed Spain TOU locks injection to 0€.
    // We still use it because periodos P1-P6 give more savings than excedentes.
    return isSpainTariff ? 'Fixed (Spain — time-of-use)' : 'Fixed';
  }
  return 'Dynamic';
}


// ═══════════════════════════════════════════
// STRATEGY DERIVATION
// ═══════════════════════════════════════════

export function deriveStrategy(simConfig) {
  const contractType = deriveContractType(simConfig);

  // If Fixed Spain TOU: check if all prices are the same (no spread → self-supply)
  if (contractType === 'Fixed (Spain — time-of-use)') {
    const fijo = simConfig.contrato_electrico?.cfg_fijo;
    if (fijo) {
      const vals = Object.values(fijo);
      const allSame = vals.every(v => Math.abs(v - vals[0]) < 0.001);
      if (allSame) return 'Self-supply';
    }
  }

  // If no FV and no price spread → self-supply
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
    note: `Fórmula ROI: TE = A + B×OMIE. A = costes fijos (cts/kWh), B = multiplicador spot. Voltmasters: scaling factor ≈ ${avgB.toFixed(3)} (B), consumption cost ≈ ${(avgA * 10).toFixed(1)} €/MWh (A×10).`,
  };
}


// ═══════════════════════════════════════════
// FIXED CONTRACT PRICES (for Fixed Spain TOU)
// ═══════════════════════════════════════════

export function deriveFixedPrices(simConfig) {
  const fijo = simConfig.contrato_electrico?.cfg_fijo;
  if (!fijo) return null;

  // cfg_fijo values are in €/kWh → convert to €/MWh for Voltmasters
  const prices = {};
  for (const [p, v] of Object.entries(fijo)) {
    prices[p] = v * 1000;
  }
  return prices;
}


// ═══════════════════════════════════════════
// PEAK SHAVING RESERVE DERIVATION
// ═══════════════════════════════════════════

export function derivePeakShavingReserve(simConfig, payload) {
  const pc = simConfig.optimizador_lp?.pc_override_kw || simConfig.suministro?.potencias_optimas_kw;
  const picoBESS = payload?.balance_energetico_anual_kwh?.pico_anual_bess_kw ?? 0;
  const potenciaKw = simConfig.bateria?.potencia_kw ?? 0;

  if (!pc) return { value: 0, reason: 'Sin potencias óptimas → no se puede evaluar. Dejar en 0% y ajustar en campo.' };

  const minLimit = Math.min(...Object.values(pc));

  if (picoBESS > minLimit) {
    const overshoot = ((picoBESS - minLimit) / minLimit * 100).toFixed(0);
    const canCover = potenciaKw >= (picoBESS - minLimit);
    return {
      value: 25,
      reason: `Pico BESS (${Math.round(picoBESS)} kW) supera grid import limit mínimo (${minLimit} kW) en un ${overshoot}%. ${canCover ? 'La batería tiene potencia suficiente para recortar.' : '⚠️ La batería (' + potenciaKw + ' kW) NO tiene suficiente potencia para cubrir el exceso (' + Math.round(picoBESS - minLimit) + ' kW).'} Reservar 25% de SOC.`,
    };
  }

  return {
    value: 0,
    reason: `Pico BESS (${Math.round(picoBESS)} kW) ≤ grid import limit mínimo (${minLimit} kW). Cost Optimization gestiona los picos sin necesidad de reserva.`,
  };
}


// ═══════════════════════════════════════════
// ALERTS GENERATOR (GAP 3 + Problemas 1,4,6)
// ═══════════════════════════════════════════

export function generateAlerts(simConfig, payload, baseConfig) {
  const alerts = [];

  // Problema 1: Fixed Spain TOU + excedentes > 0
  const precioExcedentes = simConfig.contrato_electrico?.precio_excedentes_eur_kwh ?? 0;
  if (precioExcedentes > 0 && baseConfig.vm_contract_type === 'Fixed (Spain — time-of-use)') {
    alerts.push({
      tipo: 'warning', codigo: 'EXCEDENTES_CONFLICT',
      mensaje: `El cliente tiene un precio de excedentes pactado (${(precioExcedentes * 1000).toFixed(1)} €/MWh), pero Fixed Spain TOU bloquea la inyección a 0 €/MWh. La batería NO venderá energía proactivamente. En 6.1 TD priorizamos periodos P1-P6 sobre venta de excedentes.`,
    });
  }

  // Problema 4: Dynamic + scaling promediado
  if (baseConfig.vm_contract_type === 'Dynamic' && baseConfig.scaling) {
    alerts.push({
      tipo: 'info', codigo: 'SCALING_AVERAGED',
      mensaje: `Contrato indexado. Voltmasters en modo Dynamic usa un único Consumption cost para las 24h. Los peajes del ROI varían por periodo (P1-P6), pero aquí se promedian. Puede afectar al arbitraje nocturno.`,
    });
  }

  // Problema 6: Pico BESS > Import limit
  const pc = simConfig.optimizador_lp?.pc_override_kw || simConfig.suministro?.potencias_optimas_kw;
  const picoBESS = payload?.balance_energetico_anual_kwh?.pico_anual_bess_kw ?? 0;
  const potenciaKw = simConfig.bateria?.potencia_kw ?? 0;
  if (pc) {
    const maxPot = Math.max(...Object.values(pc));
    if (picoBESS > maxPot) {
      alerts.push({
        tipo: 'warning', codigo: 'PICO_EXCEDE_LIMIT',
        mensaje: `La batería (${potenciaKw} kW nominal) no tiene suficiente potencia para mantener el pico (${Math.round(picoBESS)} kW) por debajo del límite contratado (${maxPot} kW). El peak shaving será parcial.`,
      });
    }
  }

  // GAP 3: Spread vs Minimum price difference
  if (baseConfig.fixed_prices) {
    const vals = Object.values(baseConfig.fixed_prices);
    const spread = Math.max(...vals) - Math.min(...vals);
    if (spread < baseConfig.vm_min_price_diff) {
      alerts.push({
        tipo: 'warning', codigo: 'SPREAD_BELOW_MPD',
        mensaje: `El spread entre periodos (${spread.toFixed(1)} €/MWh) es MENOR que Minimum price difference (${baseConfig.vm_min_price_diff} €/MWh). Voltmasters NO hará arbitraje. Considerar reducir el MPD.`,
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

  // Grid connection type
  const tension = (simConfig.suministro?.tension_contador || '').toUpperCase();
  const maxPot = Math.max(...Object.values(simConfig.suministro?.potencias_actuales_kw || { P1: 0 }));
  const gridConnectionType = (tension === 'BT' && maxPot <= 15) ? 'Single-phase' : 'Three-phase';

  // Battery injection (Problema 1)
  const hasExport = exportacion > 0 || precioExcedentes > 0;
  const batteryInjection = hasExport && contractType === 'Dynamic';
  const excedentesConflict = precioExcedentes > 0 && contractType === 'Fixed (Spain — time-of-use)';

  // Problema 3: Import safety margin — fixed absolute value
  const pc = simConfig.optimizador_lp?.pc_override_kw || simConfig.suministro?.potencias_optimas_kw;
  const minOptPower = pc ? Math.min(...Object.values(pc)) : null;
  const safetyMargin = minOptPower && minOptPower > 500 ? 15 : 10;

  // Min price difference
  let minPriceDiff = 20;
  if (fixedPrices) {
    const vals = Object.values(fixedPrices);
    const spread = Math.max(...vals) - Math.min(...vals);
    minPriceDiff = Math.max(15, Math.round(spread * 0.5));
  }

  const config = {
    // Identity
    nombre: simConfig.nombre_simulacion || '',
    tarifa: simConfig.suministro?.tarifa || '',
    tipo_contrato_roi: simConfig.contrato_electrico?.tipo_contrato || '',
    tension_contador: tension,

    // Voltmasters: Contract & Strategy
    vm_contract_type: contractType,
    vm_control_strategy: strategy,

    // Grid limits
    vm_grid_export_limit: exportacion === 0 ? 0 : null,
    vm_import_safety_margin: safetyMargin,

    // Battery
    vm_min_soc: simConfig.bateria?.soc_min_pct ?? 10,
    vm_max_soc: simConfig.bateria?.soc_max_pct ?? 90,
    vm_round_trip_eff: Math.round((simConfig.bateria?.eta_charge ?? 0.95) * (simConfig.bateria?.eta_discharge ?? 0.95) * 100),

    // Strategy params
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

    // Scaling (Dynamic contract)
    scaling: scaling,

    // Fixed prices (Fixed Spain TOU)
    fixed_prices: fixedPrices,

    // Potencias contratadas
    potencias_actuales: simConfig.suministro?.potencias_actuales_kw || null,
    potencias_optimas: simConfig.suministro?.potencias_optimas_kw || null,
    pc_override: simConfig.optimizador_lp?.pc_override_kw || null,

    // Battery info
    bateria_modelo: simConfig.bateria?.modelo || '',
    bateria_kwh: simConfig.bateria?.capacidad_kwh || 0,
    bateria_util_kwh: simConfig.bateria?.capacidad_util_kwh || 0,
    bateria_kw: simConfig.bateria?.potencia_kw || 0,
    bateria_unidades: simConfig.bateria?.unidades || 1,
    fv_kwp: simConfig.fotovoltaica?.kwp || 0,
    precio_excedentes: precioExcedentes,

    // Savings breakdown (from payload)
    ahorro_fv: payload?.resultado?.optimizacion_fv?.ahorro_con_ie_eur ?? 0,
    ahorro_arbitraje: payload?.resultado?.arbitraje?.ahorro_con_ie_eur ?? 0,
    ahorro_peak_shaving: (payload?.resultado?.peak_shaving?.ahorro_potencia_con_ie_eur ?? 0) + (payload?.resultado?.peak_shaving?.ahorro_excesos_eur ?? 0),
    ahorro_fv_desc: payload?.resultado?.optimizacion_fv?.descripcion ?? '',
    ahorro_arb_desc: payload?.resultado?.arbitraje?.descripcion ?? '',
    ahorro_ps_desc: payload?.resultado?.peak_shaving?.descripcion ?? '',

    // ROI results
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
