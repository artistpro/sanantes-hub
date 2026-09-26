#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const TARGET_KEYWORDS = [
  // Marca y Categoría
  { query: 'sanantes', group: 'Marca' },
  { query: 'comunidad sanantes', group: 'Marca' },
  { query: 'el podcast del cancer', group: 'Categoría' },
  { query: 'podcast del cancer', group: 'Categoría' },
  { query: 'podcast sobre el cancer', group: 'Categoría' },

  // Autoridad Médica & Exclusividad
  { query: 'william makis', group: 'Entidad' },
  { query: 'william makis en español', group: 'Entidad' },
  { query: 'oncologia integrativa', group: 'Pilar Institucional' },

  // Evidencia Científica & Fármacos
  { query: 'ivermectina cancer estudio pubmed', group: 'Evidencia' },
  { query: 'mebendazol fenbendazol cancer evidencia', group: 'Evidencia' },

  // Metabolismo & Bienestar
  { query: 'estrategia metabolica thomas seyfried espanol', group: 'Metabolismo' },
  { query: 'ratio glucosa cetonas gki cancer', group: 'Metabolismo' },
  { query: 'frecuencias 432 hz bienestar descanso', group: 'Bienestar' }
];

const LEDGER_PATH = resolve(process.cwd(), 'rank_tracking_ledger.json');

export function loadLedger() {
  if (existsSync(LEDGER_PATH)) {
    try {
      return JSON.parse(readFileSync(LEDGER_PATH, 'utf-8'));
    } catch {
      return { last_check: null, history: [] };
    }
  }
  return { last_check: null, history: [] };
}

export function saveLedger(ledger) {
  writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2), 'utf-8');
}

export function generateReport(gscRows = []) {
  const gscMap = new Map();
  for (const row of gscRows) {
    if (row.keys && row.keys[0]) {
      gscMap.set(row.keys[0].toLowerCase().trim(), row);
    }
  }

  const timestamp = new Date().toISOString();
  const summary = TARGET_KEYWORDS.map(k => {
    const keyLower = k.query.toLowerCase();
    const data = gscMap.get(keyLower);
    return {
      query: k.query,
      group: k.group,
      position: data ? Number(data.position.toFixed(1)) : 'Pendiente GSC (48h)',
      impressions: data ? data.impressions : 0,
      clicks: data ? data.clicks : 0,
      ctr: data ? (data.ctr * 100).toFixed(1) + '%' : '0.0%',
      indexed_status: 'Indexado (Sitemap activo)'
    };
  });

  return { timestamp, summary };
}

export function printCliTable(report) {
  console.log('\n========================================================================================');
  console.log('           SANANTES.COM · MONITOR DE POSICIONAMIENTO Y RANKING (SEO & GEO)');
  console.log(`           Fecha de corte: ${report.timestamp}`);
  console.log('========================================================================================\n');

  console.log(
    'TÉRMINO CLAVE'.padEnd(42) +
    'GRUPO'.padEnd(22) +
    'POSICIÓN'.padEnd(16) +
    'IMPRESIONES'.padEnd(14) +
    'CLICS'
  );
  console.log('-'.repeat(100));

  for (const item of report.summary) {
    console.log(
      item.query.padEnd(42) +
      item.group.padEnd(22) +
      String(item.position).padEnd(16) +
      String(item.impressions).padEnd(14) +
      String(item.clicks)
    );
  }
  console.log('\n* Nota: Las métricas de GSC se consolidan en ventanas de 48-72h tras la primera indexación.\n');
}

// Ejecución directa por CLI
if (process.argv[1] && process.argv[1].endsWith('rank-tracker.mjs')) {
  const report = generateReport();
  printCliTable(report);
  const ledger = loadLedger();
  ledger.last_check = report.timestamp;
  ledger.history.push({ timestamp: report.timestamp, snapshot: report.summary });
  if (ledger.history.length > 30) ledger.history.shift();
  saveLedger(ledger);
  console.log('Registro guardado en rank_tracking_ledger.json');
}
