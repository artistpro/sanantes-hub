import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export class BudgetExceededError extends Error {
  constructor(message = 'Presupuesto diario o límite de llamadas excedido.') {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

export class CircuitBreakerOpenError extends Error {
  constructor(message = 'Disyuntor abierto: Demasiados fallos consecutivos en API externa.') {
    super(message);
    this.name = 'CircuitBreakerOpenError';
  }
}

function getLedgerPath() {
  return process.env.BUDGET_LEDGER_PATH || path.resolve(process.cwd(), '.budget_ledger.json');
}

export async function loadLedger() {
  const today = new Date().toISOString().slice(0, 10);
  let data = { date: today, calls: {}, costUSD: 0, consecutiveFailures: {}, circuitOpenUntil: {} };
  const target = getLedgerPath();
  if (existsSync(target)) {
    try {
      const raw = await readFile(target, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed.date === today) {
        data = { ...data, ...parsed };
      }
    } catch {
      // Ignorar errores de lectura o corrupción y arrancar fresco hoy
    }
  }
  return data;
}

export async function saveLedger(data) {
  try {
    const target = getLedgerPath();
    await writeFile(target, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn('Advertencia: No se pudo persistir el budget ledger:', err.message);
  }
}

export async function checkBudgetGuard(service = 'typesafe_jev') {
  if (process.env.BUDGET_GUARD_DISABLED === '1') {
    return { bypassed: true };
  }
  const maxCalls = Number(process.env.BUDGET_MAX_DAILY_CALLS || 50);
  const maxCost = Number(process.env.BUDGET_MAX_DAILY_COST_USD || 0.10);
  const ledger = await loadLedger();

  // 1. Verificación de Disyuntor (Circuit Breaker)
  const openUntil = ledger.circuitOpenUntil?.[service] || 0;
  if (Date.now() < openUntil) {
    const remainingSec = Math.ceil((openUntil - Date.now()) / 1000);
    throw new CircuitBreakerOpenError(`Disyuntor activo para ${service}. Reintentos bloqueados por ${remainingSec}s más.`);
  }

  // 2. Hard-Limit de Llamadas Diarias
  const serviceCalls = ledger.calls?.[service] || 0;
  if (serviceCalls >= maxCalls) {
    throw new BudgetExceededError(`Tope diario de llamadas para ${service} alcanzado (${serviceCalls}/${maxCalls}).`);
  }

  // 3. Hard-Limit de Costo Acumulado
  if (ledger.costUSD >= maxCost) {
    throw new BudgetExceededError(`Tope diario de costo acumulado alcanzado ($${ledger.costUSD.toFixed(3)} / $${maxCost.toFixed(2)} USD).`);
  }

  return { ledger, serviceCalls, maxCalls, costUSD: ledger.costUSD };
}

export async function recordBudgetSuccess(service = 'typesafe_jev', estimatedCostUSD = 0.001) {
  if (process.env.BUDGET_GUARD_DISABLED === '1') return;
  const ledger = await loadLedger();
  ledger.calls[service] = (ledger.calls[service] || 0) + 1;
  ledger.costUSD = Number((Number(ledger.costUSD || 0) + Number(estimatedCostUSD)).toFixed(5));
  ledger.consecutiveFailures[service] = 0;
  if (ledger.circuitOpenUntil?.[service]) {
    delete ledger.circuitOpenUntil[service];
  }
  await saveLedger(ledger);
  return ledger;
}

export async function recordBudgetFailure(service = 'typesafe_jev', maxFailures = 3, cooldownMs = 15 * 60 * 1000) {
  if (process.env.BUDGET_GUARD_DISABLED === '1') return;
  const ledger = await loadLedger();
  const currentFailures = (ledger.consecutiveFailures[service] || 0) + 1;
  ledger.consecutiveFailures[service] = currentFailures;

  if (currentFailures >= maxFailures) {
    ledger.circuitOpenUntil = ledger.circuitOpenUntil || {};
    ledger.circuitOpenUntil[service] = Date.now() + cooldownMs;
    console.warn(`[CIRCUIT BREAKER] Disyuntor activado para ${service}: ${currentFailures} fallos consecutivos.`);
  }
  await saveLedger(ledger);
  return ledger;
}

export async function resetBudgetLedger() {
  const target = getLedgerPath();
  const today = new Date().toISOString().slice(0, 10);
  const data = { date: today, calls: {}, costUSD: 0, consecutiveFailures: {}, circuitOpenUntil: {} };
  await saveLedger(data);
  return data;
}
