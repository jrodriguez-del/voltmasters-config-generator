# ⚡ Voltmasters Config Generator

Analiza las curvas de ROI Baterías y genera la configuración exacta del EMS Voltmasters para lograr el ahorro simulado.

## 🎯 Qué hace

1. **Lee** la carpeta de salida de ROI Baterías (3 archivos: `configuracion_simulacion.json`, `cavo_payload_b2b.json`, `cavo_curvas_netted_bess.csv`)
2. **Analiza** 35.039 filas de curvas cuarto-horarias con 4 motores matemáticos
3. **Genera** un reporte HTML paso a paso que simula la interfaz de Voltmasters
4. **El instalador** mira el papel, mira la pantalla de VM, y copia los valores

## 🏗️ Arquitectura

```
index.html          → UI (drop zone + iframe preview)
styles.css          → CSS dark mode (interfaz de entrada)
js/app.js           → Orquestador (pipeline completo)
js/analyzer.js      → Motor matemático (4 análisis)
js/rules.js         → Reglas de negocio (ROI → VM)
js/renderer.js      → Renderizador HTML + CSS del reporte
```

### Pipeline

```
Archivos → app.js (CSV parser) → analyzer.js + rules.js → JSON Canónico (GAP 7) → renderer.js → HTML/PDF
```

## 🔧 Análisis implementados

| # | Análisis | Módulo | Descripción |
|---|----------|--------|-------------|
| 1 | Métricas mensuales | `analyzer.js` | 12 meses: carga/descarga, picos, spread, ciclos |
| 2 | Periodos tarifarios | `analyzer.js` | P1-P6: comportamiento, fuente de carga, horas |
| 3 | Peak Shaving Reserve | `analyzer.js` | Detección de vaciado con SoC directo (GAP 1) |
| 4 | Calendario CNMC | `analyzer.js` | Transiciones filtradas (Problema 2 resuelto) |

## 🛡️ GAPs resueltos

- **GAP 1**: SoC directo del CSV para detección de vaciado (no heurístico)
- **GAP 3**: Validación spread vs Minimum Price Difference
- **GAP 7**: JSON Canónico Intermedio (desacopla math ↔ UI)

## 🚀 Uso

1. Abrir `index.html` en cualquier navegador moderno
2. Arrastrar la carpeta de ROI Baterías (o usar los botones)
3. El reporte se genera al instante en el iframe
4. Descargar como HTML (auto-contenido, imprimible con Ctrl+P)

**Zero dependencies. Zero install. 100% browser JavaScript.**

## 📄 Licencia

CAVO Energías — Uso interno
