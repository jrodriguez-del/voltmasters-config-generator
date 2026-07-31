/**
 * renderer.js — Renderizador HTML del reporte Voltmasters
 * 
 * Consume el JSON intermedio canónico (GAP 7) y produce HTML del reporte.
 * Completamente desacoplado del análisis y las reglas.
 */

// ═══════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════

const num = (v, d = 0) => v != null && !isNaN(v) ? Number(v).toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
const PCOL = { P1: '#dc2626', P2: '#ea580c', P3: '#d97706', P4: '#2563eb', P5: '#059669', P6: '#6b7280' };
const pbadge = p => `<span style="display:inline-block;padding:1px 6px;border-radius:3px;font-size:.7rem;font-weight:700;background:${PCOL[p]}15;color:${PCOL[p]};border:1px solid ${PCOL[p]}40">${p}</span>`;
const step = (n, title) => `<div class="step-num">${n}</div><div class="step-title">${title}</div>`;
const field = (label, value) => `<div class="field-row"><span class="field-label">${label}</span><span class="field-value"><code>${value}</code></span></div>`;


// ═══════════════════════════════════════════
// MAIN RENDER FUNCTION
// ═══════════════════════════════════════════

export function renderReport(jsonData) {
  const { baseConfig, monthly, calendar, periodData, reserveData, scheduleData, alerts } = jsonData;

  const pc = baseConfig.pc_override || baseConfig.potencias_optimas;
  const hasPcChanges = pc && !Object.values(pc).every(v => v === Object.values(pc)[0]);
  const { transitions: cnmcTransitions, changes: scheduleChanges } = scheduleData;

  let html = '';

  // ═══════════════════════════════════════════
  // HEADER
  // ═══════════════════════════════════════════
  html += `
<div class="report-header">
  <h1>📋 Guía de Comisionado Voltmasters</h1>
  <p class="subtitle">${baseConfig.nombre}</p>
  <div class="meta-row">
    <span>🔋 ${baseConfig.bateria_modelo} × ${baseConfig.bateria_unidades}</span>
    <span>📦 ${num(baseConfig.bateria_kwh)} kWh / ${num(baseConfig.bateria_kw)} kW</span>
    ${baseConfig.fv_kwp > 0 ? `<span>☀️ FV ${num(baseConfig.fv_kwp)} kWp</span>` : ''}
    <span>📝 ${baseConfig.tarifa} · ${baseConfig.tipo_contrato_roi}</span>
    <span>💰 Ahorro objetivo: <strong>${num(baseConfig.ahorro_eur, 0)} €/año</strong></span>
  </div>
</div>`;

  // ═══════════════════════════════════════════
  // ALERTS PANEL (GAP 3 + Problemas 1,4,6)
  // ═══════════════════════════════════════════
  if (alerts && alerts.length > 0) {
    html += `<div class="section" style="border-left:4px solid #dc2626">
  <div class="section-hdr"><div class="icon">🚨</div><h2>Alertas y Conflictos Detectados (${alerts.length})</h2></div>
  ${alerts.map(a => `<div class="alert ${a.tipo === 'warning' ? 'alert-w' : 'alert-i'}">
    ${a.tipo === 'warning' ? '⚠️' : 'ℹ️'} <strong>[${a.codigo}]</strong> ${a.mensaje}
  </div>`).join('')}
</div>`;
  }

  // ═══════════════════════════════════════════
  // FASE 1: CONFIGURACIÓN DEL PROYECTO
  // ═══════════════════════════════════════════
  html += `<div class="section section-highlight">
  <div class="section-hdr"><div class="icon">🔧</div><h2>Fase 1 — Configuración del Proyecto</h2></div>
  <p class="section-desc">Settings → Project Settings → General Settings</p>

  <div class="step">
    ${step(1, 'Grid Settings — Configuración de red')}
    <p class="step-location">Settings → Project Settings → General Settings → <strong>Grid settings</strong></p>
    <div class="field-grid">
      ${field('Main meter (desplegable)', '← Seleccionar el analizador de redes del punto de frontera')}
      ${field('Grid connection type (desplegable)', baseConfig.vm_grid_connection_type)}
      ${field('Import limit (kW)', (pc ? Math.max(...Object.values(pc)) : '—') + ' kW')}
      ${field('Export limit (kW)', num(baseConfig.vm_grid_export_limit) + ' kW')}
      ${field('Import safety margin (kW)', num(baseConfig.vm_import_safety_margin) + ' kW')}
      ${field('Export safety margin (kW)', '0 kW')}
      ${field('Reactive power import limit (%)', '100%')}
      ${field('Reactive power export limit (%)', '100%')}
    </div>
    <p class="step-desc"><strong>Grid capacity / contract power changes:</strong></p>
    <div class="field-grid">
      ${field('Selector', hasPcChanges ? '→ Scheduled for later execution' : '→ Applied immediately')}
    </div>
    ${baseConfig.vm_grid_export_limit === 0 ? '<div class="alert alert-i">ℹ️ Export limit = 0 kW → <strong>inyección cero</strong>. El EMS recortará la FV si hay exceso.</div>' : ''}
  </div>

  ${hasPcChanges ? `<div class="step">
    ${step(2, 'Cambios programados de Grid Import Limit')}
    <p class="step-location">Settings → Project Settings → Grid settings → <strong>Scheduled grid capacity changes</strong></p>
    <p class="step-desc">Las potencias contratadas varían por temporada CNMC. Programar los cambios para que se apliquen automáticamente:</p>
    <table>
      <thead><tr><th>Fecha</th><th>Grid import limit</th><th>Temporada</th><th>Meses</th></tr></thead>
      <tbody>
        ${calendar.map(e => `<tr${e.changed ? ' style="background:#fffbeb"' : ''}>
          <td><strong>${getSeasonStartDate(e.season)}</strong></td>
          <td><code>${e.gridLimit || Math.ceil(e.maxPeakBESS)} kW</code></td>
          <td>${e.label} (${e.period})</td>
          <td>${e.months}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div class="alert alert-w">⚠️ Seleccionar <strong>"Scheduled for later execution"</strong> para cada cambio. Introducir la fecha y el valor en kW. El sistema lo aplicará automáticamente.</div>
  </div>` : `<div class="step">
    ${step(2, 'Grid Import Limit — Sin cambios estacionales')}
    <p class="step-desc">Las potencias contratadas son iguales en todos los periodos (<code>${pc ? Object.values(pc)[0] : '—'} kW</code>). No hay que programar cambios estacionales.</p>
  </div>`}
</div>`;

  // ═══════════════════════════════════════════
  // FASE 2: CONTRATO DE ENERGÍA
  // ═══════════════════════════════════════════
  html += `<div class="section section-highlight">
  <div class="section-hdr"><div class="icon">📄</div><h2>Fase 2 — Contrato de Energía</h2></div>

  <div class="step">
    ${step(3, 'Energy Contract — Contrato de energía')}
    <p class="step-location">Settings → Project Settings → General Settings → <strong>Energy contract</strong></p>
    <div class="field-grid">
      ${field('Contract type (desplegable)', baseConfig.vm_contract_type)}
    </div>
    <p class="step-desc">Opciones: <code>Dynamic contract</code> · <code>Flexible contract</code> · <code>Fixed contract</code> · <code>Fixed (Spain — time-of-use)</code></p>
  </div>`;

  // Contract-specific fields
  if (baseConfig.fixed_prices && baseConfig.vm_contract_type === 'Fixed (Spain \u2014 time-of-use)') {
    html += `<div class="step">
    ${step(4, 'Sub-campos: Fixed (Spain \u2014 time-of-use)')}
    <p class="step-location">Energy contract → <strong>aparecen al seleccionar Fixed Spain TOU</strong></p>
    <p class="step-desc">Al seleccionar este tipo, aparecen 6 campos de precio. Introducir en <strong>€/MWh</strong>:</p>
    <div class="field-grid">
      ${field('P1 Price (€/MWh número)', baseConfig.fixed_prices.P1.toFixed(2))}
      ${field('P2 Price (€/MWh número)', baseConfig.fixed_prices.P2.toFixed(2))}
      ${field('P3 Price (€/MWh número)', baseConfig.fixed_prices.P3.toFixed(2))}
      ${field('P4 Price (€/MWh número)', baseConfig.fixed_prices.P4.toFixed(2))}
      ${field('P5 Price (€/MWh número)', baseConfig.fixed_prices.P5.toFixed(2))}
      ${field('P6 Price (€/MWh número)', baseConfig.fixed_prices.P6.toFixed(2))}
    </div>
    <div class="alert alert-i">ℹ️ <strong>Inyección = 0 €/MWh</strong> (bloqueado automáticamente por la plataforma). La batería solo descarga para cubrir consumo propio.</div>
    ${baseConfig.vm_excedentes_conflict ? '<div class="alert alert-w">⚠️ <strong>CONFLICTO:</strong> Este cliente tiene un precio de excedentes pactado (' + (baseConfig.precio_excedentes * 1000).toFixed(1) + ' €/MWh), pero <code>Fixed Spain TOU</code> bloquea la inyección a 0 €/MWh. Voltmasters nunca venderá energía proactivamente. Regla de negocio CAVO: en 6.1 TD priorizamos periodos P1-P6 sobre venta de excedentes.</div>' : ''}
  </div>`;
  } else if (baseConfig.scaling && baseConfig.vm_contract_type === 'Dynamic') {
    html += `<div class="step">
    ${step(4, 'Sub-campos: Dynamic contract')}
    <p class="step-location">Energy contract → <strong>aparecen al seleccionar Dynamic</strong></p>
    <p class="step-desc">Al seleccionar Dynamic, aparecen estos campos de escalado:</p>
    <div class="field-grid">
      ${field('Consumption scaling factor A (número)', baseConfig.scaling.vm_scaling_factor.toFixed(4))}
      ${field('Consumption cost (€/MWh número)', baseConfig.scaling.vm_consumption_cost_eur_mwh.toFixed(1) + ' €/MWh')}
      ${field('Distribution cost (€/MWh número)', '← Según contrato')}
      ${field('Injection scaling factor B (número)', '1.0 (o según contrato)')}
      ${field('Injection cost (€/MWh número)', '0 €/MWh')}
    </div>
    <div class="alert alert-w">⚠️ Verificar A (${baseConfig.scaling.vm_scaling_factor.toFixed(2)}) y consumption cost (${baseConfig.scaling.vm_consumption_cost_eur_mwh.toFixed(0)} €/MWh) con la comercializadora.</div>
    <div class="alert alert-w">⚠️ <strong>LIMITACIÓN VM:</strong> Voltmasters en modo Dynamic usa un único <code>Consumption cost</code> para las 24h. Los peajes del ROI varían por periodo (P1-P6), pero aquí se promedian. Puede afectar al arbitraje nocturno.</div>
  </div>`;
  } else {
    html += `<div class="step">
    ${step(4, 'Sub-campos del contrato')}
    <p class="step-location">Energy contract → <strong>aparecen al seleccionar el tipo</strong></p>
    <p class="step-desc">Según el tipo seleccionado, pueden aparecer:</p>
    <div class="field-grid">
      ${field('consumption price (€/MWh)', '← Fixed / Flexible')}
      ${field('injection price (€/MWh)', '← Fixed / Flexible')}
      ${field('— O bien —', '')}
      ${field('6 precios P1-P6 (€/MWh)', '← Fixed Spain TOU')}
      ${field('— O bien —', '')}
      ${field('Scaling factor A + costs', '← Dynamic')}
    </div>
  </div>`;
  }
  html += `</div>`;

  // ═══════════════════════════════════════════
  // FASE 3: ESTRATEGIA DE CONTROL
  // ═══════════════════════════════════════════
  html += `<div class="section section-highlight">
  <div class="section-hdr"><div class="icon">🧠</div><h2>Fase 3 — Estrategia de Control</h2></div>
  <p class="section-desc">Settings → Project Settings → General Settings → <strong>Strategy</strong></p>

  <div class="step">
    ${step(5, 'Strategy Settings — Todos los campos')}
    <p class="step-location">Settings → Project Settings → General Settings → <strong>Strategy</strong></p>
    <div class="field-grid">
      ${field('Strategy (desplegable)', baseConfig.vm_control_strategy)}
    </div>
    <p class="step-desc">Al seleccionar <code>Voltmasters Cost Optimisation</code> aparecen estos sub-campos:</p>
    <div class="field-grid">
      ${field('├ Minimum price difference (€/MWh)', num(baseConfig.vm_min_price_diff) + ' €/MWh')}
      ${field('├ Grey zone (kW)', baseConfig.vm_grey_zone + ' kW')}
      ${field('├ Peak shaving reserve (% SoC)', baseConfig.vm_peak_shaving_reserve + '%')}
      ${field('├ Battery load balancing strategy (desplegable)', baseConfig.vm_battery_load_balancing || 'N/A (1 sola batería)')}
      ${field('├ Selling via battery injection (toggle)', baseConfig.vm_battery_injection ? 'Enable ✅' : 'Disable ❌')}
      ${baseConfig.vm_battery_injection ? field('│  └ Grid charging for injection (toggle)', baseConfig.vm_grid_charging_injection ? 'Enable ✅' : 'Disable ❌') : field('│  └ Grid charging for injection', '(oculto — solo visible si Selling = Enable)')}
    </div>
    <div class="alert ${baseConfig.vm_peak_shaving_reserve > 0 ? 'alert-w' : 'alert-i'}">
      ${baseConfig.vm_peak_shaving_reserve > 0 ? '⚠️' : 'ℹ️'} <strong>Peak shaving reserve = ${baseConfig.vm_peak_shaving_reserve}%</strong> — ${baseConfig.vm_peak_shaving_reason}
    </div>
    ${!baseConfig.vm_battery_injection && baseConfig.vm_grid_export_limit === 0 ? '<div class="alert alert-i">ℹ️ <strong>Selling via battery injection = Disable</strong> porque Export limit = 0 kW (inyección cero).</div>' : ''}
    ${!baseConfig.vm_battery_injection && baseConfig.vm_contract_type === 'Fixed (Spain \u2014 time-of-use)' ? '<div class="alert alert-i">ℹ️ Fixed Spain TOU → inyección = 0 €/MWh. Activar Selling no tendría efecto (nunca supera min price difference).</div>' : ''}
  </div>
</div>`;

  // ═══════════════════════════════════════════
  // FASE 4: DISPOSITIVOS
  // ═══════════════════════════════════════════
  const devStep = 6;
  html += `<div class="section section-highlight">
  <div class="section-hdr"><div class="icon">🔌</div><h2>Fase 4 — Configuración de Dispositivos</h2></div>
  <p class="section-desc">My Devices → Add device (asistente interactivo por cada equipo)</p>

  <div class="step">
    ${step(devStep, 'Baterías — Pestaña Settings')}
    <p class="step-location">My Devices → [Batería] → <strong>Settings</strong></p>
    <p class="step-desc">Dar de alta ${baseConfig.bateria_unidades > 1 ? 'las ' + baseConfig.bateria_unidades + ' baterías' : 'la batería'} (${baseConfig.bateria_modelo}). Campos en pestaña Settings:</p>
    <div class="field-grid">
      ${field('Device name (texto)', baseConfig.bateria_modelo)}
      ${field('Minimum SOC (% número)', num(baseConfig.vm_min_soc) + '%')}
      ${field('Maximum SOC (% número)', num(baseConfig.vm_max_soc) + '%')}
      ${field('Capacity (kWh número)', num(baseConfig.bateria_kwh) + ' kWh')}
      ${field('Nominal power (kW número)', num(baseConfig.bateria_kw) + ' kW')}
      ${field('Round-trip efficiency (% número)', num(baseConfig.vm_round_trip_eff) + '%')}
      ${field('Auto-calibrate enabled (toggle)', 'Enabled ✅')}
      ${field('Correction factor charge (número)', '1.0')}
      ${field('Correction factor discharge (número)', '1.0')}
    </div>
    <p class="step-desc">Pestaña <strong>Communication</strong>:</p>
    <div class="field-grid">
      ${field('Protocol (desplegable)', 'Modbus TCP/IP')}
      ${field('IP address (texto)', '← IP estática de la batería')}
      ${field('Port (número)', '502')}
      ${field('Slave ID (número)', '1')}
      ${field('Exclusivity of TCP connection (toggle)', 'Exclusive connection')}
    </div>
  </div>

  ${baseConfig.fv_kwp > 0 ? `<div class="step">
    ${step(devStep + 1, 'Inversores FV — Pestaña Settings')}
    <p class="step-location">My Devices → [PV Inverter] → <strong>Settings</strong></p>
    <p class="step-desc">Dar de alta los inversores FV (${num(baseConfig.fv_kwp)} kWp total). Campos:</p>
    <div class="field-grid">
      ${field('Device name (texto)', '← Nombre del inversor')}
      ${field('Controllable (toggle)', 'ON ✅ (obligatorio)')}
      ${field('Production capacity / Nominal power (kW)', '← Potencia nominal del inversor')}
      ${field('Panel Tilt (grados 0-90)', '← Inclinación de los paneles')}
      ${field('Panel Azimuth (grados 0-360)', '← Orientación geográfica')}
      ${field('Green power certificate price per MWh (€/MWh)', '0 €/MWh')}
    </div>
    <p class="step-desc">Pestaña <strong>Communication</strong>:</p>
    <div class="field-grid">
      ${field('Protocol (desplegable)', 'Modbus TCP/IP')}
      ${field('IP address (texto)', '← IP estática del inversor')}
      ${field('Port (número)', '502')}
      ${field('Slave ID (número)', '← Según fabricante')}
    </div>
    <div class="alert alert-w">⚠️ <strong>Controllable = ON es obligatorio</strong> para que el EMS pueda recortar la FV y respetar Export limit = ${num(baseConfig.vm_grid_export_limit)} kW.</div>
  </div>` : ''}

  <div class="step">
    ${step(devStep + (baseConfig.fv_kwp > 0 ? 2 : 1), 'Analizador de redes (Energy Meter)')}
    <p class="step-location">My Devices → [Energy Meter] → <strong>Settings</strong></p>
    <p class="step-desc">Dar de alta el contador de cabecera. Campos:</p>
    <div class="field-grid">
      ${field('Device name (texto)', '← Nombre del analizador')}
      ${field('Measurement type (desplegable)', '1 - Grid connection')}
      ${field('Current transformer ratio (número)', '← Según instalación')}
      ${field('Voltage transformer ratio (número)', '← Según instalación')}
      ${field('Metering direction (desplegable)', 'Normal')}
    </div>
    <p class="step-desc">Después, asignar en <strong>Grid settings → Main meter</strong> este dispositivo.</p>
  </div>
</div>`;

  // ═══════════════════════════════════════════
  // FASE 5: CALENDARIO ANUAL
  // ═══════════════════════════════════════════
  const calStep = devStep + (baseConfig.fv_kwp > 0 ? 3 : 2);
  html += `<div class="section section-highlight">
  <div class="section-hdr"><div class="icon">📅</div><h2>Fase 5 — Calendario Anual de Configuración</h2></div>
  <p class="section-desc">Los <strong>únicos parámetros que se pueden programar</strong> en Voltmasters para ejecución futura son los límites de red (<em>Grid capacity</em>). El resto de parámetros (Strategy, prices, etc.) son estáticos y se aplican inmediatamente al guardar.</p>

  <div class="step">
    ${step(calStep, 'Scheduled Grid Capacity Changes')}
    <p class="step-location">Settings → Project Settings → General Settings → Grid settings → <strong>Scheduled for later execution</strong></p>
    ${hasPcChanges ? `<p class="step-desc">Las potencias varían por periodo. <strong>Solo se crean eventos Scheduled donde el Import limit cambia</strong> respecto al periodo anterior (${scheduleChanges.length} cambios reales de ${cnmcTransitions.length} transiciones CNMC):</p>
    <table>
      <thead><tr><th>Fecha</th><th>Campo: <code>Import limit</code></th><th>Periodo punta</th><th>Temporada</th></tr></thead>
      <tbody>
        ${scheduleChanges.map(t => `<tr style="background:#fffbeb">
          <td><strong>${t.date}</strong></td>
          <td><code>${t.gridLimit || '—'} kW</code></td>
          <td>${pbadge(t.period)}</td>
          <td><small>${t.season} (${t.months})</small></td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div class="alert alert-w">⚠️ <strong>Acción:</strong> Crear ${scheduleChanges.length} eventos Scheduled en Grid settings → <em>"Scheduled for later execution"</em> con la fecha e Import limit indicados.</div>` :
    `<p class="step-desc">Calendario CNMC de referencia (potencias iguales, no se necesitan cambios programados):</p>
    <table>
      <thead><tr><th>Fecha</th><th>Campo: <code>Import limit</code></th><th>Periodo punta</th><th>Temporada</th></tr></thead>
      <tbody>
        ${cnmcTransitions.map(t => `<tr>
          <td><strong>${t.date}</strong></td>
          <td><code>${t.gridLimit || '—'} kW</code></td>
          <td>${pbadge(t.period)}</td>
          <td><small>${t.season} (${t.months})</small></td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div class="alert alert-i">ℹ️ Todas las potencias son <code>${pc ? Object.values(pc)[0] : '—'} kW</code>. No se necesitan cambios programados.</div>`}
  </div>

  <div class="step">
    ${step(calStep + 1, 'Parámetros que NO cambian durante el año')}
    <p class="step-desc">Estos parámetros son <strong>estáticos</strong> — se configuran una vez y Voltmasters no permite programarlos para ejecución futura:</p>
    <div class="field-grid">
      ${field('Strategy', baseConfig.vm_control_strategy + ' (todo el año)')}
      ${field('Minimum price difference', num(baseConfig.vm_min_price_diff) + ' €/MWh (todo el año)')}
      ${field('Peak shaving reserve', baseConfig.vm_peak_shaving_reserve + '% (todo el año)')}
      ${field('Export limit', num(baseConfig.vm_grid_export_limit) + ' kW (todo el año)')}
      ${field('Selling via battery injection', (baseConfig.vm_battery_injection ? 'ON' : 'OFF') + ' (todo el año)')}
      ${field('Minimum SOC / Maximum SOC', num(baseConfig.vm_min_soc) + '% / ' + num(baseConfig.vm_max_soc) + '% (todo el año)')}
    </div>
    <div class="alert alert-i">ℹ️ Si se quiere cambiar alguno de estos parámetros por temporada, hay que hacerlo <strong>manualmente</strong> en la fecha correspondiente.</div>
  </div>
</div>`;

  // ═══════════════════════════════════════════
  // FASE 6: CONSUMPTION PLANNING
  // ═══════════════════════════════════════════
  const cpStep = calStep + 2;
  const consumptionEvents = [];
  if (periodData && periodData.length > 0) {
    for (const p of periodData) {
      if (p.topDischarge.length > 0 && p.descarga > 500) {
        const mainHours = p.topDischarge.slice(0, 3);
        const startH = Math.min(...mainHours.map(x => x.h));
        const endH = Math.max(...mainHours.map(x => x.h)) + 1;
        consumptionEvents.push({
          name: 'Descarga ' + p.period + ' (horas punta)',
          period: p.period,
          startTime: startH + ':00',
          duration: (endH - startH) + 'h',
          nominalPower: p.picoDischarge,
          recurrence: 'Lunes a Viernes',
          description: 'El EMS descarga ' + num(p.descarga) + ' kWh durante ' + p.period + '. Horas principales: ' + mainHours.map(x => x.h + 'h').join(', ') + '.',
        });
      }
    }
  }

  html += `<div class="section section-highlight">
  <div class="section-hdr"><div class="icon">📋</div><h2>Fase 6 — Consumption Planning (Planificación de Consumo)</h2></div>
  <p class="section-desc">Settings → Project Settings → <strong>Consumption planning</strong></p>

  <div class="step">
    ${step(cpStep, 'Eventos de consumo planificado')}
    <p class="step-location">Settings → Project Settings → <strong>Consumption planning</strong></p>
    <p class="step-desc">La planificación de consumo permite al EMS <strong>precargar la batería</strong> antes de eventos de demanda conocidos. Crear los siguientes eventos basados en la simulación:</p>
    ${consumptionEvents.length > 0 ? `<table>
      <thead><tr><th>Nombre</th><th>Campo: <code>Nominal power</code></th><th>Campo: <code>Start time</code></th><th>Campo: <code>Duration</code></th><th>Campo: <code>Recurrence</code></th></tr></thead>
      <tbody>
        ${consumptionEvents.map(e => `<tr>
          <td>${pbadge(e.period)} <strong>${e.name}</strong></td>
          <td><code>${e.nominalPower} kW</code></td>
          <td><code>${e.startTime}</code></td>
          <td><code>${e.duration}</code></td>
          <td><code>${e.recurrence}</code></td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div class="alert alert-i">ℹ️ Estos eventos informan al EMS de la demanda esperada. Con esta información, el algoritmo de <strong>Cost Optimisation</strong> precargará la batería en horas baratas (P6 / FV) para cubrir la demanda durante los periodos caros.</div>` :
    `<div class="alert alert-i">ℹ️ El consumo de esta planta es muy <strong>plano/continuo</strong> (típico de procesos industriales 24/7). No se detectan eventos discretos de demanda que requieran planificación. El EMS de Cost Optimisation gestiona el arbitraje automáticamente basándose en los precios por periodo.</div>
    <p class="step-desc">Si en el futuro se instala maquinaria adicional con demanda puntual (hornos, compresores grandes, turnos de fábrica), crear eventos con estos campos:</p>
    <div class="field-grid">
      ${field('Name (texto)', '(nombre descriptivo del evento)')}
      ${field('Nominal power (kW número)', '(demanda esperada en kW)')}
      ${field('Start time (selector hora)', '(hora de inicio del evento)')}
      ${field('Duration (número h/min)', '(duración estimada)')}
      ${field('Recurrence (desplegable)', 'Once/None \u00b7 Daily \u00b7 Weekly')}
      ${field('\u2514 Weekdays (checkbox, si Weekly)', 'Mon Tue Wed Thu Fri Sat Sun')}
    </div>`}
  </div>
</div>`;

  // ═══════════════════════════════════════════
  // RESUMEN EJECUTIVO
  // ═══════════════════════════════════════════
  html += `<div class="section">
  <div class="section-hdr"><div class="icon">📊</div><h2>Resumen de Configuración</h2></div>
  <table><tbody>
    <tr><td>Strategy</td><td><strong><code>${baseConfig.vm_control_strategy}</code></strong></td></tr>
    <tr><td>Contrato</td><td><strong><code>${baseConfig.vm_contract_type}</code></strong></td></tr>
    <tr><td>Grid import limit</td><td><strong><code>${pc ? (hasPcChanges ? 'Variable por temporada (ver Fase 5)' : Object.values(pc)[0] + ' kW') : '—'}</code></strong></td></tr>
    <tr><td>Grid export limit</td><td><strong><code>${num(baseConfig.vm_grid_export_limit)} kW</code></strong></td></tr>
    <tr><td>SOC</td><td><strong><code>${num(baseConfig.vm_min_soc)}% \u2013 ${num(baseConfig.vm_max_soc)}%</code></strong></td></tr>
    <tr><td>Min price difference</td><td><strong><code>${num(baseConfig.vm_min_price_diff)} \u20ac/MWh</code></strong></td></tr>
    <tr><td>Peak shaving reserve</td><td><strong><code>${baseConfig.vm_peak_shaving_reserve}%</code></strong></td></tr>
    <tr><td>Battery injection</td><td><strong><code>${baseConfig.vm_battery_injection ? 'ON' : 'OFF'}</code></strong></td></tr>
    ${baseConfig.vm_battery_load_balancing ? `<tr><td>Load balancing</td><td><strong><code>${baseConfig.vm_battery_load_balancing}</code></strong></td></tr>` : ''}
    ${baseConfig.vm_pv_controllable ? '<tr><td>PV Controllable</td><td><strong><code>ON</code></strong></td></tr>' : ''}
  </tbody></table>
</div>`;

  // ═══════════════════════════════════════════
  // ANEXOS: PERIODO, RESERVA, MENSUAL, HEATMAP
  // ═══════════════════════════════════════════
  html += renderPeriodSection(periodData);
  html += renderReserveSection(reserveData, baseConfig);
  html += renderSavingsSection(baseConfig);
  html += renderMonthlySection(monthly);
  html += renderHeatmap(monthly);

  // Footer
  html += `<div class="footer">
  Generado automáticamente — CAVO Energías \u00b7 Generador de Configuración Voltmasters<br>
  ${new Date().toLocaleString('es-ES')}
</div>`;

  return html;
}


// ═══════════════════════════════════════════
// SUB-RENDERERS
// ═══════════════════════════════════════════

function renderPeriodSection(periodData) {
  if (!periodData || periodData.length === 0) return '';
  let html = `<div class="section section-highlight">
  <div class="section-hdr"><div class="icon">⏱️</div><h2>Comportamiento de la Batería por Periodo Tarifario</h2></div>
  <p class="section-desc">Qué hace <strong>exactamente</strong> la batería durante cada periodo tarifario según la simulación.</p>
  <table>
    <thead><tr><th>Periodo</th><th>Acción</th><th>Carga</th><th>Descarga</th><th>Fuente carga</th><th>Peak \u0394</th><th>Horas carg.</th><th>Horas desc.</th><th>Precio</th></tr></thead>
    <tbody>
      ${periodData.map(p => `<tr>
        <td>${pbadge(p.period)} <small>(${p.hours}h/a\u00f1o)</small></td>
        <td><span class="op-badge" style="--c:${p.behaviorColor}">${p.behavior}</span></td>
        <td><code>${num(p.cargaTotal)}</code> kWh</td>
        <td><code>${num(p.descarga)}</code> kWh</td>
        <td>${p.pctFV}% FV / ${100 - p.pctFV}% Red</td>
        <td>${p.peakDelta > 0 ? `<strong>${p.picoSQ} \u2192 ${p.picoBESS} kW</strong> (\u2212${p.peakDelta})` : `${p.picoSQ} kW (sin cambio)`}</td>
        <td><small>${p.topCharge.map(x => x.h + 'h').join(', ') || '\u2014'}</small></td>
        <td><small>${p.topDischarge.map(x => x.h + 'h').join(', ') || '\u2014'}</small></td>
        <td><small>${(p.avgPrecio * 1000).toFixed(1)} \u20ac/MWh</small></td>
      </tr>`).join('')}
    </tbody>
  </table>
</div>`;

  // Detail cards
  html += `<div class="section">
  <div class="section-hdr"><div class="icon">🔍</div><h2>Detalle por Periodo \u2014 Qué debe hacer el EMS</h2></div>
  <p class="section-desc">Descripción detallada de la operación objetivo en cada periodo.</p>
  ${periodData.map(p => `
  <div class="config-card" style="--accent-color:${p.behaviorColor}">
    <div class="config-header">
      <div>
        <span class="config-date">${pbadge(p.period)} \u2014 ${p.behavior}</span>
        <span class="config-months">${p.hours} horas/a\u00f1o \u00b7 ${(p.avgPrecio * 1000).toFixed(1)} \u20ac/MWh</span>
      </div>
    </div>
    <p class="config-desc">${p.descripcion}</p>
    <div class="config-summary">
      <span>\u2b06\ufe0f Carga: <strong>${num(p.cargaTotal)} kWh</strong> (${p.pctFV}% FV)</span>
      <span>\u2b07\ufe0f Descarga: <strong>${num(p.descarga)} kWh</strong></span>
      <span>\u26a1 Pico: <strong>${p.picoSQ} \u2192 ${p.picoBESS} kW</strong></span>
      <span>\ud83d\udd50 Carg: ${p.hCarga}h \u00b7 Desc: ${p.hDescarga}h \u00b7 Idle: ${p.hIdle}h</span>
    </div>
  </div>`).join('')}
</div>`;
  return html;
}


function renderReserveSection(reserveData, baseConfig) {
  if (!reserveData || reserveData.length === 0) return '';
  const TCOL = { OK: '#059669', RESERVE: '#dc2626' };
  const TICON = { OK: '\u2705', RESERVE: '\u26a0\ufe0f' };
  const TLABEL = { OK: 'Sin acción', RESERVE: 'Peak Shaving Reserve' };

  const needsReserve = reserveData.some(r => r.type === 'RESERVE');
  const maxReserve = Math.max(0, ...reserveData.filter(r => r.type === 'RESERVE').map(r => r.reservePct));

  let html = `<div class="section section-highlight">
  <div class="section-hdr"><div class="icon">�\udee1\ufe0f</div><h2>Análisis de Reserva de Energía (Peak Shaving Reserve)</h2></div>
  <p class="section-desc">\u00bfSe vacía la batería antes de los picos de demanda? <strong>Nota:</strong> Consumption Planning NO protege picos de potencia \u2014 solo Peak Shaving Reserve lo garantiza.</p>

  ${needsReserve ? '<div class="alert alert-w">\u26a0\ufe0f <strong>Se recomienda Peak shaving reserve = ' + maxReserve + '%</strong> en Settings \u2192 Strategy \u2192 Peak shaving reserve.</div>' : ''}
  ${!needsReserve ? '<div class="alert alert-i">\u2705 <strong>Peak shaving reserve = 0% es correcto</strong> para toda la instalación.</div>' : ''}

  <table>
    <thead><tr><th>Mes</th><th>Acción</th><th>Peak shaving</th><th>Doble ciclo</th><th>Días vacía</th><th>Carga red</th><th>Configuración VM</th></tr></thead>
    <tbody>
      ${reserveData.map(r => `<tr>
        <td><strong>${r.name}</strong></td>
        <td><span class="op-badge" style="--c:${TCOL[r.type] || '#6b7280'}">${TICON[r.type] || '\u2014'} ${TLABEL[r.type] || r.type}</span></td>
        <td>${r.doesPS ? '<strong>' + r.maxSQ + ' \u2192 ' + r.maxBESS + ' kW</strong> (\u2212' + r.peakDelta + ')' : '<small>No recorta</small>'}</td>
        <td>${r.doubleCycle ? '\u26a1 Sí (' + r.chargeHrs.join(',') + 'h \u2192 ' + r.dischargeHrs.join(',') + 'h)' : 'No'}</td>
        <td>${r.emptyBefore > 0 ? '<strong>' + r.emptyBefore + '/' + r.totalDays + '</strong> (' + r.riskPct + '%)' : '0/' + r.totalDays}</td>
        <td>${r.gridCh.length > 0 ? r.gridCh.map(h => h + 'h').join(', ') : '\u2014'}</td>
        <td><small>${r.rec}</small></td>
      </tr>`).join('')}
    </tbody>
  </table>

  ${needsReserve ? `<div class="step">
    <div class="step-num">\u26a1</div><div class="step-title">Campo a configurar</div>
    <p class="step-desc"><strong>Peak shaving reserve:</strong></p><div class="field-grid">${field('Peak shaving reserve (% SoC)', maxReserve + '% \u2192 Settings \u2192 Strategy \u2192 Peak shaving reserve')}</div>
    <p class="step-desc">Reserva un ${maxReserve}% del SOC exclusivamente para recortar picos. Este es el <strong>\u00fanico mecanismo fiable</strong> en Voltmasters para garantizar energía disponible para peak shaving.</p>
  </div>` : ''}
</div>`;
  return html;
}


function renderSavingsSection(baseConfig) {
  const totalAhorro = baseConfig.ahorro_fv + baseConfig.ahorro_arbitraje + baseConfig.ahorro_peak_shaving;
  if (totalAhorro <= 0) return '';
  const pct = v => totalAhorro > 0 ? (v / totalAhorro * 100).toFixed(0) : '0';
  return `<div class="section">
  <div class="section-hdr"><div class="icon">�\udcb6</div><h2>Anexo A \u2014 Desglose del Ahorro (${num(baseConfig.ahorro_eur, 0)} \u20ac/a\u00f1o)</h2></div>
  <table>
    <thead><tr><th>Concepto</th><th>Ahorro</th><th>%</th><th>Descripción</th></tr></thead>
    <tbody>
      <tr><td>\u2600\ufe0f Autoconsumo FV</td><td><code>${num(baseConfig.ahorro_fv, 0)} \u20ac</code></td><td>${pct(baseConfig.ahorro_fv)}%</td><td><small>${baseConfig.ahorro_fv_desc || 'Almacena excedentes solares para consumo posterior'}</small></td></tr>
      <tr><td>\ud83d\udcca Arbitraje</td><td><code>${num(baseConfig.ahorro_arbitraje, 0)} \u20ac</code></td><td>${pct(baseConfig.ahorro_arbitraje)}%</td><td><small>${baseConfig.ahorro_arb_desc || 'Carga en horas baratas, descarga en horas caras'}</small></td></tr>
      <tr><td>\u26a1 Peak Shaving</td><td><code>${num(baseConfig.ahorro_peak_shaving, 0)} \u20ac</code></td><td>${pct(baseConfig.ahorro_peak_shaving)}%</td><td><small>${baseConfig.ahorro_ps_desc || 'Reducción de potencia contratada'}</small></td></tr>
    </tbody>
  </table>
</div>`;
}


function renderMonthlySection(monthly) {
  if (!monthly || monthly.length === 0) return '';
  return `<div class="section">
  <div class="section-hdr"><div class="icon">�\udcc8</div><h2>Anexo B \u2014 Operación Mensual de la Batería</h2></div>
  <table>
    <thead><tr><th>Mes</th><th>Tipo</th><th>Pico SQ</th><th>Pico BESS</th><th>% FV</th><th>Ciclos</th><th>Spread</th><th>Carga</th><th>Descarga</th></tr></thead>
    <tbody>
      ${monthly.map(m => `<tr>
        <td><strong>${m.name}</strong></td>
        <td><span class="op-badge" style="--c:${m.color}">${m.tipo}</span></td>
        <td>${num(m.picoSQ)} kW</td><td>${num(m.picoBESS)} kW</td>
        <td>${num(m.pctFV, 0)}%</td><td>${num(m.ciclos, 1)}</td>
        <td>${num(m.spread * 1000, 1)} \u20ac/MWh</td>
        <td><small>${m.chargeHours.map(x => x.h + 'h').join(', ')}</small></td>
        <td><small>${m.dischargeHours.map(x => x.h + 'h').join(', ')}</small></td>
      </tr>`).join('')}
    </tbody>
  </table>
</div>`;
}


function renderHeatmap(monthly) {
  if (!monthly || monthly.length === 0) return '';
  const cellW = 52, cellH = 6;
  let heatSvg = '';
  for (const m of monthly) {
    const maxVal = Math.max(...m.hCharge, ...m.hDischarge, 1);
    const mx = 40 + (m.month - 1) * (cellW + 8);
    for (let h = 0; h < 24; h++) {
      const y = 18 + h * cellH;
      const cVal = m.hCharge[h]; const dVal = m.hDischarge[h];
      let fill, opacity;
      if (cVal > dVal) { fill = '#059669'; opacity = Math.min(1, cVal / maxVal); }
      else if (dVal > 0) { fill = '#dc2626'; opacity = Math.min(1, dVal / maxVal); }
      else { fill = '#6b7280'; opacity = 0.05; }
      heatSvg += `<rect x="${mx}" y="${y}" width="${cellW}" height="${cellH - 1}" fill="${fill}" opacity="${opacity}" rx="1"/>`;
    }
    heatSvg += `<text x="${mx + cellW / 2}" y="14" text-anchor="middle" font-size="8" fill="#9ca3af">${m.name.substring(0, 3)}</text>`;
  }
  for (let h = 0; h < 24; h += 2) {
    heatSvg += `<text x="36" y="${22 + h * cellH}" text-anchor="end" font-size="7" fill="#9ca3af">${h}h</text>`;
  }
  return `<div class="section">
  <div class="section-hdr"><div class="icon">�\uddfa\ufe0f</div><h2>Anexo C \u2014 Mapa de Calor</h2></div>
  <p class="section-desc"><span style="color:#059669">\u25a0 Carga</span> \u00b7 <span style="color:#dc2626">\u25a0 Descarga</span></p>
  <div class="heatmap-wrap"><svg viewBox="0 0 740 180">${heatSvg}</svg></div>
</div>`;
}


// ═══════════════════════════════════════════
// REPORT CSS
// ═══════════════════════════════════════════

export function getReportCSS() { return `
:root {
  --bg:#f3f4f6; --card:#fff; --row:#fafbfc; --row2:#f0f2f5; --th:#e8ebf0;
  --border:#d5d9e0; --text:#1a1d24; --text2:#4b5563; --muted:#6b7280;
  --accent:#2563eb; --accent2:#7c3aed; --green:#059669; --amber:#d97706; --red:#dc2626;
  --vm-input-bg:#f8fafc; --vm-input-border:#cbd5e1;
}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.7}

/* \u2500\u2500 Report Header \u2500\u2500 */
.report-header{background:linear-gradient(180deg,#fff,var(--bg));border-bottom:2px solid var(--accent);padding:2rem 2rem 1.5rem;text-align:center}
.report-header h1{font-size:1.5rem;font-weight:800;letter-spacing:-.5px;color:var(--accent)}
.subtitle{font-size:.88rem;color:var(--text2);margin-top:.4rem}
.meta-row{font-size:.74rem;color:var(--muted);margin-top:.8rem;display:flex;gap:1.2rem;justify-content:center;flex-wrap:wrap;background:var(--accent);color:#fff;padding:.6rem 1rem;border-radius:6px;font-weight:600}

/* \u2500\u2500 Layout \u2500\u2500 */
.container{max-width:1100px;margin:0 auto;padding:1.5rem 2rem}

/* \u2500\u2500 Sections \u2500\u2500 */
.section{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:1.5rem 1.8rem;margin-bottom:1.2rem}
.section-highlight{border-left:4px solid var(--accent)}
.section-hdr{display:flex;align-items:center;gap:.6rem;margin-bottom:.8rem;padding-bottom:.5rem;border-bottom:1px solid var(--border)}
.section-hdr .icon{width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:1rem;background:var(--th)}
.section-hdr h2{font-size:1.05rem;font-weight:700}
.section-desc{font-size:.78rem;color:var(--text2);margin-bottom:.8rem}
h3{font-size:.88rem;font-weight:600;color:var(--accent);margin:1rem 0 .5rem}

/* \u2500\u2500 Tables \u2500\u2500 */
table{width:100%;border-collapse:collapse;font-size:.78rem;border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:.5rem}
thead{background:var(--th)} th{padding:.5rem .7rem;text-align:left;font-weight:600;font-size:.68rem;text-transform:uppercase;letter-spacing:.04em;color:var(--text2);border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:.45rem .7rem;border-bottom:1px solid rgba(213,217,224,.4)} td strong{color:var(--accent);font-weight:600}
td code{background:var(--vm-input-bg);color:var(--accent);padding:2px 8px;border-radius:4px;font-size:.78rem;font-weight:600;font-family:'Cascadia Code','Fira Code',monospace;border:1px dashed var(--vm-input-border)}
.path{font-size:.66rem;color:var(--muted);font-style:italic}
tr:nth-child(even){background:var(--row2)} tr:nth-child(odd){background:var(--row)} tr:last-child td{border-bottom:none}

/* \u2500\u2500 Alerts \u2500\u2500 */
.alert{border-radius:8px;padding:.6rem .8rem;margin:.5rem 0;font-size:.76rem;display:flex;align-items:flex-start;gap:.4rem;line-height:1.5}
.alert-w{background:#fffbeb;border:1px solid #fde68a;color:#92400e;border-left:4px solid #ffc107}
.alert-i{background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af;border-left:4px solid #3b82f6}

/* \u2500\u2500 Badges \u2500\u2500 */
.op-badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:.68rem;font-weight:600;background:color-mix(in srgb,var(--c) 12%,transparent);color:var(--c);border:1px solid color-mix(in srgb,var(--c) 35%,transparent)}

/* \u2500\u2500 Config Cards (Period Detail) \u2500\u2500 */
.config-card{border:1px solid var(--border);border-radius:10px;padding:1rem 1.2rem;margin-bottom:1rem;border-left:4px solid var(--accent-color);background:var(--row)}
.config-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:.4rem}
.config-date{font-weight:700;font-size:.9rem}
.config-months{margin-left:.6rem;font-size:.72rem;color:var(--muted)}
.config-desc{font-size:.74rem;color:var(--text2);margin-bottom:.6rem;padding:.4rem .6rem;background:var(--card);border-radius:6px;border:1px dashed var(--border)}
.config-settings{display:flex;flex-direction:column;gap:.5rem}
.setting-row{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:.5rem .7rem;border-left:3px solid var(--accent)}
.setting-changed{border-left:3px solid var(--amber);background:#fffbeb}
.setting-param{font-size:.76rem;font-weight:700;color:var(--text)}
.setting-value{font-size:.82rem;margin:.1rem 0}
.setting-path{font-size:.64rem;color:var(--muted);font-style:italic}
.setting-reason{font-size:.72rem;color:var(--text2);margin-top:.15rem}
.config-summary{display:flex;gap:1rem;margin-top:.6rem;font-size:.72rem;color:var(--muted)}

/* \u2500\u2500 Heatmap \u2500\u2500 */
.heatmap-wrap{overflow-x:auto;background:var(--row);border:1px solid var(--border);border-radius:8px;padding:.8rem}
.heatmap-wrap svg{width:100%;max-width:740px;height:auto}

/* \u2500\u2500 Footer \u2500\u2500 */
.footer{margin-top:2rem;padding:1rem 0;border-top:1px solid var(--border);text-align:center;color:var(--muted);font-size:.68rem}

/* \u2500\u2500 Print Button \u2500\u2500 */
.print-btn{position:fixed;bottom:1.5rem;right:1.5rem;background:var(--accent);color:#fff;border:none;border-radius:50px;padding:.6rem 1.2rem;font-size:.78rem;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif;z-index:100;box-shadow:0 2px 8px rgba(37,99,235,.3)}
.print-btn:hover{background:#1d4ed8}

/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
   STEP CARDS \u2014 Simulated Voltmasters UI
   \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
.step{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:1.2rem 1.4rem;margin-bottom:1rem;display:flex;flex-wrap:wrap;gap:.5rem .8rem;align-items:flex-start;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.step-num{width:34px;height:34px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:.88rem;flex-shrink:0;box-shadow:0 2px 6px rgba(37,99,235,.25)}
.step-title{font-weight:700;font-size:.92rem;flex:1;min-width:200px;padding-top:6px}

/* VM Path bar \u2014 prominent blue breadcrumb */
.step-location{width:100%;font-size:.74rem;color:var(--accent);font-weight:600;padding:.4rem .8rem .4rem 42px;margin:-.1rem 0 .6rem;background:rgba(37,99,235,.05);border-radius:6px;border:1px solid rgba(37,99,235,.15);display:flex;align-items:center;gap:.3rem}
.step-location::before{content:'\ud83d\udccd';font-size:.8rem}

.step-desc{width:100%;font-size:.78rem;color:var(--text2);padding-left:42px;margin-bottom:.5rem}

/* Field Grid \u2014 simulated VM input fields */
.field-grid{width:100%;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:.4rem;padding-left:42px}

/* Individual field row \u2014 looks like a VM form field */
.field-row{display:flex;justify-content:space-between;align-items:center;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:.5rem .8rem;transition:border-color .15s}
.field-row:hover{border-color:var(--accent)}
.field-label{font-size:.76rem;color:var(--text2);font-weight:500;flex:1;min-width:0}
.field-value{font-size:.82rem;font-weight:600;flex-shrink:0;max-width:55%}

/* The value inside the field \u2014 simulated input box */
.field-value code{
  background:var(--vm-input-bg);
  color:var(--accent);
  padding:4px 10px;
  border-radius:5px;
  font-size:.8rem;
  font-weight:600;
  font-family:'Cascadia Code','Fira Code','SF Mono',monospace;
  border:1px dashed var(--vm-input-border);
  display:inline-block;
  letter-spacing:.02em;
}

/* Alerts inside steps */
.step .alert{width:100%;margin-left:42px}
.step table{width:calc(100% - 42px);margin-left:42px}

/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
   PRINT STYLES
   \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
@media print{
  .print-btn{display:none!important}
  body{background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .container{padding:0;max-width:100%}
  .section{break-inside:avoid;border:1px solid #ccc;box-shadow:none;margin-bottom:.8rem}
  .step{break-inside:avoid;box-shadow:none;border:1px solid #ddd}
  .field-row{border:1px solid #ddd}
  .field-value code{border:1px solid #bbb}
  .report-header{border-bottom:2px solid #333}
  .meta-row{background:#333;color:#fff}
  .step-location{background:rgba(37,99,235,.08);border:1px solid rgba(37,99,235,.2)}
  .alert-w{border-left:4px solid #ffc107}
  .alert-i{border-left:4px solid #3b82f6}
}
`; }


function getSeasonStartDate(season) {
  const dates = { 'ALTA': '1 Enero / 1 Julio', 'MEDIA_ALTA': '1 Marzo / 1 Noviembre', 'MEDIA': '1 Junio', 'BAJA': '1 Abril' };
  return dates[season] || '\u2014';
}
