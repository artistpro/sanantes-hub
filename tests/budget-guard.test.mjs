import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBudgetGuard, recordBudgetSuccess, recordBudgetFailure, resetBudgetLedger, loadLedger, BudgetExceededError, CircuitBreakerOpenError } from '../lib/budget-guard.mjs';
import { classify, classificationDefaults } from '../lib/classifier.mjs';
process.env.LOCAL_DATABASE_PATH = ':memory:';
const { initialize } = await import('../scripts/init.mjs');
await initialize();

test('Budget Guard: Hard-limit diario de llamadas bloquea peticiones', async () => {
  await resetBudgetLedger();
  process.env.BUDGET_MAX_DAILY_CALLS = '2';
  process.env.BUDGET_MAX_DAILY_COST_USD = '1.0';

  // 1ra llamada exitosa
  await checkBudgetGuard('test_service');
  await recordBudgetSuccess('test_service', 0.01);

  // 2da llamada exitosa
  await checkBudgetGuard('test_service');
  await recordBudgetSuccess('test_service', 0.01);

  // 3ra llamada debe disparar BudgetExceededError ANTES de enviar petición
  await assert.rejects(
    () => checkBudgetGuard('test_service'),
    BudgetExceededError
  );

  delete process.env.BUDGET_MAX_DAILY_CALLS;
  delete process.env.BUDGET_MAX_DAILY_COST_USD;
});

test('Budget Guard: Circuit Breaker se abre tras 3 fallos consecutivos', async () => {
  await resetBudgetLedger();
  process.env.BUDGET_MAX_DAILY_CALLS = '100';

  // 1er y 2do fallo
  await recordBudgetFailure('api_fail_test', 3, 5000);
  await recordBudgetFailure('api_fail_test', 3, 5000);
  // Aún pasa porque van 2 de 3
  await checkBudgetGuard('api_fail_test');

  // 3er fallo consecutivo abre el circuito
  await recordBudgetFailure('api_fail_test', 3, 5000);

  // Debe rechazar con CircuitBreakerOpenError
  await assert.rejects(
    () => checkBudgetGuard('api_fail_test'),
    CircuitBreakerOpenError
  );

  // Éxito en otro servicio no se afecta (aislamiento de servicio)
  await checkBudgetGuard('other_service');

  delete process.env.BUDGET_MAX_DAILY_CALLS;
});

test('Budget Guard: Fallback no-bloqueante conmuta a review sin romper flujo', async () => {
  await resetBudgetLedger();
  process.env.BUDGET_MAX_DAILY_CALLS = '0'; // Simular presupuesto agotado
  process.env.TYPESAFE_API_KEY = 'mock-key';

  const video = { id: 'budget-test-vid', platform: 'odysee', title: 'Video de prueba', duration: 300 };
  const config = { ...classificationDefaults, classificationEnabled: '1' };

  // Debe responder con fallback a 'review' en lugar de lanzar excepción fatal
  const res = await classify(video, config, async () => {
    throw new Error('No debió llamar a la red');
  });

  assert.equal(res.kind, 'review');
  assert.equal(res.fallback, true);

  delete process.env.BUDGET_MAX_DAILY_CALLS;
  await resetBudgetLedger();
});
