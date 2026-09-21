import {excludeInterrupted} from '../lib/publication.mjs';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {query} from '../lib/db.mjs';
export async function initialize(){
  const schema=await readFile(new URL('../lib/schema.sql',import.meta.url),'utf8');for(const statement of schema.split(';').map(x=>x.trim()).filter(Boolean))await query(statement);
  for(const s of [{id:'podcast-odysee',name:'El Podcast del Cáncer · Odysee',platform:'odysee',url:'https://odysee.com/@ElPodcastdelCancer:3',external:'3fe18c9c35ed73eff22e56470b53ec85c7332913'},{id:'podcast-youtube',name:'El Podcast del Cáncer · YouTube',platform:'youtube',url:'https://www.youtube.com/@podcastcancer',external:null}])await query('INSERT INTO sources(id,name,platform,url,own,external_id) VALUES(?,?,?,?,1,?) ON CONFLICT(id) DO NOTHING',[s.id,s.name,s.platform,s.url,s.external]);
  const seeds=JSON.parse(await readFile(new URL('../lib/catalog.json',import.meta.url),'utf8'));
  for(const v of seeds)await query('INSERT INTO videos(id,source_id,platform,external_id,title,description,url,thumbnail,duration,published_at,kind,status,category,featured) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(platform,external_id) DO NOTHING',[v.id,v.source_id,v.platform,v.external_id,v.title,v.description,v.url,v.thumbnail,v.duration,v.published_at,v.kind,v.status,v.category,v.featured||0]);
  const classifications=JSON.parse(await readFile(new URL('../lib/classifications.json',import.meta.url),'utf8'));
  for(const c of classifications)await query('INSERT INTO classifications(fingerprint,video_id,model,response,input_tokens,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(fingerprint) DO NOTHING',[c.fingerprint,c.video_id,c.model,c.response,c.input_tokens,c.created_at]);
  const labels=JSON.parse(await readFile(new URL('../lib/media-labels.json',import.meta.url),'utf8'));
  for(const c of labels)await query('INSERT INTO media_labels(video_id,fingerprint,category,relevance,response,model,input_tokens,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(video_id) DO NOTHING',[c.video_id,c.fingerprint,c.category,c.relevance,c.response,c.model,c.input_tokens,c.updated_at]);
  await excludeInterrupted(query);
  console.log('Base de datos inicializada. Fuentes y catálogo importados sin sobrescribir cambios.');
}
if(process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))await initialize();
