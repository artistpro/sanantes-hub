import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';

process.env.LOCAL_DATABASE_PATH = ':memory:';
process.env.DEV_AUTH = '1';
process.env.ADMIN_EMAIL = 'admin@example.test';
delete process.env.TURSO_DATABASE_URL;
delete process.env.VERCEL;

const {initialize} = await import('../scripts/init.mjs');
await initialize();

const {default: handler} = await import('../api/index.js');
const {query} = await import('../lib/db.mjs');

const server = createServer(handler);
await new Promise(r => server.listen(0, '127.0.0.1', r));
process.env.APP_ORIGIN = 'http://127.0.0.1:' + server.address().port;
const base = process.env.APP_ORIGIN;

after(() => server.close());

test('SEO: /robots.txt incluye Content-Signal y referencia al sitemap', async () => {
  const res = await fetch(`${base}/api/robots.txt`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/plain/);
  const text = await res.text();
  assert.ok(text.includes('User-agent: *'));
  assert.ok(text.includes('Allow: /'));
  assert.ok(text.includes('Content-Signal: search=yes, ai-input=yes, ai-train=no'));
  assert.ok(text.includes('/sitemap.xml'));
});

test('SEO: /sitemap.xml genera sitemap con extensión de Google Video', async () => {
  const res = await fetch(`${base}/api/sitemap.xml`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/xml/);
  const xml = await res.text();
  assert.ok(xml.includes('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'));
  assert.ok(xml.includes('xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"'));
  assert.ok(xml.includes('<video:video>'));
  assert.ok(xml.includes('<video:title>'));
  assert.ok(xml.includes('<video:thumbnail_loc>'));
  assert.ok(xml.includes('<loc>'));
});

test('SEO & GEO: /v/:id y /b/:slug inyectan Schema.org JSON-LD (VideoObject y MedicalWebPage)', async () => {
  const [vid] = await query("SELECT id FROM videos WHERE status='published' LIMIT 1");
  assert.ok(vid, 'Debe haber al menos un video publicado');

  const vRes = await fetch(`${base}/api/v/${vid.id}`);
  assert.equal(vRes.status, 200);
  const vHtml = await vRes.text();
  assert.ok(vHtml.includes('application/ld+json'));
  assert.ok(vHtml.includes('"@type":"VideoObject"'));
  assert.ok(vHtml.includes('"name":'));
  assert.ok(vHtml.includes('Comunidad Sanantes'));

  // Insert a test published post if none exists
  await query("INSERT INTO posts(id,slug,title,excerpt,body,status,image) VALUES('seo-post','seo-post','Post SEO','Resumen SEO','Cuerpo','published','https://images.unsplash.com/photo-1') ON CONFLICT(id) DO NOTHING");
  const bRes = await fetch(`${base}/api/b/seo-post`);
  assert.equal(bRes.status, 200);
  const bHtml = await bRes.text();
  assert.ok(bHtml.includes('application/ld+json'));
  assert.ok(bHtml.includes('"@type":"MedicalWebPage"'));
  assert.ok(bHtml.includes('Oncology'));
});
