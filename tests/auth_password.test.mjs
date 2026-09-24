import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {hashPassword, verifyPassword} from '../lib/auth.mjs';

test('Criptografía de contraseñas: hash, salt único y verificación segura', () => {
  const pwd = 'MiClaveSegura2026!';
  const {hash, salt} = hashPassword(pwd);

  assert.ok(hash && typeof hash === 'string', 'El hash debe ser un string válido');
  assert.ok(salt && typeof salt === 'string', 'La sal debe ser un string válido');
  assert.equal(hash.length, 128, 'scrypt de 64 bytes en hex genera 128 caracteres');

  // Mismo password con distinta sal genera diferente hash
  const {hash: hash2, salt: salt2} = hashPassword(pwd);
  assert.notEqual(salt, salt2, 'Cada hash debe tener una sal aleatoria independiente');
  assert.notEqual(hash, hash2, 'Diferente sal debe generar hashes distintos para el mismo password');

  // Verificación correcta
  assert.ok(verifyPassword(pwd, hash, salt), 'Debe verificar correctamente la clave con su sal');

  // Rechazo de clave incorrecta
  assert.equal(verifyPassword('ClaveIncorrecta', hash, salt), false, 'Debe rechazar una contraseña errónea');

  // Rechazo si falta información
  assert.equal(verifyPassword('', hash, salt), false);
  assert.equal(verifyPassword(pwd, '', salt), false);
  assert.equal(verifyPassword(pwd, hash, ''), false);

  // Mínimo de 6 caracteres
  assert.throws(() => hashPassword('12345'), /al menos 6 caracteres/);
});

test('Endpoints de Auth: Registro directo y Login con contraseña', async () => {
  process.env.LOCAL_DATABASE_PATH = ':memory:';
  process.env.DEV_AUTH = '1';
  process.env.ADMIN_EMAIL = 'admin@example.test';
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.VERCEL;

  const {initialize} = await import('../scripts/init.mjs');
  await initialize();

  const {default: handler} = await import('../api/index.js');
  const server = createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  process.env.APP_ORIGIN = base;

  const call = async (path, b, cookie = '', origin = base) => {
    return fetch(base + '/api/' + path, {
      method: b ? 'POST' : 'GET',
      redirect: 'manual',
      headers: {Origin: origin, Cookie: cookie, 'Content-Type': 'application/json'},
      ...(b ? {body: JSON.stringify(b)} : {})
    });
  };

  try {
    // 1. Registro fallido por validaciones
    const resShort = await call('auth/register', {email: 'user1@test.com', password: '123', consent: true});
    assert.equal(resShort.status, 400);

    const resNoConsent = await call('auth/register', {email: 'user1@test.com', password: 'password123', consent: false});
    assert.equal(resNoConsent.status, 400);

    // 2. Registro exitoso
    const resReg = await call('auth/register', {name: 'Carlos Ruiz', email: 'user1@test.com', password: 'password123', consent: true});
    assert.equal(resReg.status, 200);
    const regData = await resReg.json();
    assert.equal(regData.ok, true);
    assert.equal(regData.me.email, 'user1@test.com');
    assert.equal(regData.me.name, 'Carlos Ruiz');
    assert.equal(regData.me.role, 'member');

    const setCookie = resReg.headers.get('set-cookie');
    assert.match(setCookie, /^session=/);
    const sessionCookie = setCookie.split(';')[0];

    // Verificar que la sesión funciona accediendo a community
    const resComm = await call('community', null, sessionCookie);
    assert.equal(resComm.status, 200);
    const commData = await resComm.json();
    assert.equal(commData.me.email, 'user1@test.com');
    assert.equal(commData.total, 10, 'Otorga 10 puntos de bienvenida');

    // 3. Intento de registro duplicado
    const resDup = await call('auth/register', {name: 'Carlos Ruiz', email: 'user1@test.com', password: 'otraPassword', consent: true});
    assert.equal(resDup.status, 400);

    // 4. Login con credenciales incorrectas
    const resBadLogin = await call('auth/login', {email: 'user1@test.com', password: 'wrongPassword'});
    assert.equal(resBadLogin.status, 401);

    const resNonExistent = await call('auth/login', {email: 'nobody@test.com', password: 'wrongPassword'});
    assert.equal(resNonExistent.status, 401);

    // 5. Login exitoso con contraseña correcta
    const resGoodLogin = await call('auth/login', {email: 'user1@test.com', password: 'password123'});
    assert.equal(resGoodLogin.status, 200);
    const loginData = await resGoodLogin.json();
    assert.equal(loginData.ok, true);
    assert.equal(loginData.me.email, 'user1@test.com');
    assert.match(resGoodLogin.headers.get('set-cookie'), /^session=/);

    // 6. Registro de admin asigna rol 'admin' automáticamente
    const resAdminReg = await call('auth/register', {name: 'Admin Sanantes', email: 'admin@example.test', password: 'adminPassword123', consent: true});
    assert.equal(resAdminReg.status, 200);
    const adminData = await resAdminReg.json();
    assert.equal(adminData.me.role, 'admin');

    const adminCookie = resAdminReg.headers.get('set-cookie').split(';')[0];
    const resAdminPanel = await call('admin', null, adminCookie);
    assert.equal(resAdminPanel.status, 200, 'Admin puede acceder al panel');

    // 7. Google login sin credencial o con credencial inválida
    const resNoCred = await call('auth/google', {});
    assert.equal(resNoCred.status, 400);

    const resBadCred = await call('auth/google', {credential: 'token-invalido-google'});
    assert.equal(resBadCred.status, 401);

  } finally {
    server.close();
  }
});
