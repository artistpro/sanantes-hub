import {query} from '../lib/db.mjs';

export async function migrateAuth(){
  console.log('Verificando columnas de autenticación en la tabla users...');
  const cols = (await query('PRAGMA table_info(users)')).map(c => c.name);
  let added = 0;
  if(!cols.includes('password_hash')){
    await query('ALTER TABLE users ADD COLUMN password_hash TEXT');
    console.log('✓ Columna password_hash agregada.');
    added++;
  }
  if(!cols.includes('password_salt')){
    await query('ALTER TABLE users ADD COLUMN password_salt TEXT');
    console.log('✓ Columna password_salt agregada.');
    added++;
  }
  if(!cols.includes('google_id')){
    await query('ALTER TABLE users ADD COLUMN google_id TEXT');
    console.log('✓ Columna google_id agregada.');
    added++;
  }
  await query('CREATE INDEX IF NOT EXISTS users_google ON users(google_id)');
  console.log(`Migración de autenticación completada. Columnas agregadas: ${added}.`);
}

if(process.argv[1] && process.argv[1].endsWith('migrate-auth.mjs')){
  await migrateAuth();
}
