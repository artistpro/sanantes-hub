import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {query} from './db.mjs';
export const token=()=>randomBytes(32).toString('hex');
export const hash=s=>createHash('sha256').update(String(s)).digest('hex');
export const now=()=>Math.floor(Date.now()/1000);
export function fail(message,status=400){throw Object.assign(new Error(message),{status});}
export function origin(){let raw=process.env.APP_ORIGIN||(process.env.VERCEL_PROJECT_PRODUCTION_URL?'https://'+process.env.VERCEL_PROJECT_PRODUCTION_URL:process.env.VERCEL_URL?'https://'+process.env.VERCEL_URL:null);if(!raw)fail('Falta configurar APP_ORIGIN',503);raw=String(raw).trim().replace(/^app_origin\s*=\s*/i,'').replace(/^["']|["']$/g,'').trim();if(!/^https?:\/\//i.test(raw))raw='https://'+raw;const u=new URL(raw);if(process.env.VERCEL&&u.protocol!=='https:')fail('APP_ORIGIN debe usar HTTPS',503);return u.origin;}
export function cookie(req,name){return (req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1)||'';}
export function setSession(res,value){res.setHeader('Set-Cookie',`session=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${value?604800:0}${origin().startsWith('https:')?'; Secure':''}`);}
export async function user(req){const t=cookie(req,'session');if(!t)return null;return (await query('SELECT users.id,users.email,users.name,users.role FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token=? AND sessions.expires>?',[hash(t),now()]))[0]||null;}
export async function requireUser(req,admin=false){const u=await user(req);if(!u)fail('Inicia sesión para continuar',401);if(admin&&u.role!=='admin')fail('Esta sección es exclusiva del administrador',403);return u;}
export async function rate(key,max,window=3600){const k=hash(key)+':'+Math.floor(now()/window);const [r]=await query('INSERT INTO rate_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count',[k,now()+window]);if(r.count>max)fail('Has realizado demasiados intentos. Inténtalo más tarde.',429);}
export function secretEqual(a,b){return !!a&&!!b&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));}
export function text(v,max=200){return typeof v==='string'?v.trim().slice(0,max):'';}
export function devAuth(){return !process.env.VERCEL&&process.env.DEV_AUTH==='1'&&/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin());}
