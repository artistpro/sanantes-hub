import {readFile,access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
for(const file of ['api/index.js','lib/auth.mjs','lib/db.mjs','lib/media.mjs','public/app.js'])execFileSync(process.execPath,['--check',file],{stdio:'inherit'});
for(const file of ['public/index.html','public/styles.css','public/favicon.svg','lib/schema.sql','lib/catalog.json'])await access(file);
const config=JSON.parse(await readFile('vercel.json'));if(config.outputDirectory!=='public')throw Error('Carpeta pública incorrecta');
console.log('Aplicación validada: frontend estático y función Node para Vercel.');
