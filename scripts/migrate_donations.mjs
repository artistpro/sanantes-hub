import {readFileSync, existsSync} from 'node:fs';
import {query} from '../lib/db.mjs';

// 1. Local SQLite
if (existsSync('development.sqlite')) {
  process.env.LOCAL_DATABASE_PATH = 'development.sqlite';
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.VERCEL;
  try {
    await query('ALTER TABLE donations ADD COLUMN user_id TEXT REFERENCES users(id)');
    console.log('Local SQLite: Columna user_id añadida con éxito.');
  } catch(e) {
    if (e.message.includes('duplicate column')) console.log('Local SQLite: Columna user_id ya existía.');
    else console.log('Local SQLite:', e.message);
  }
}

// 2. Turso Production
if (existsSync('.env.production')) {
  const content = readFileSync('.env.production', 'utf-8');
  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith('TURSO_DATABASE_URL=')) process.env.TURSO_DATABASE_URL = line.split('=')[1].trim();
    if (line.startsWith('TURSO_AUTH_TOKEN=')) process.env.TURSO_AUTH_TOKEN = line.split('=')[1].trim();
  }
  if (process.env.TURSO_DATABASE_URL) {
    try {
      await query('ALTER TABLE donations ADD COLUMN user_id TEXT REFERENCES users(id)');
      console.log('Turso Production: Columna user_id añadida con éxito.');
    } catch(e) {
      if (e.message.includes('duplicate column')) console.log('Turso Production: Columna user_id ya existía.');
      else console.log('Turso Production:', e.message);
    }
  }
}
