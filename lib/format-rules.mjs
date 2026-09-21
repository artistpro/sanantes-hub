// Observations for Jev, never a preselected format.
const confirmed = new Set([
 'od-31a14be1e2c421ec59a364396e6a0bcebd0d51b1',
 'od-2d77891415659e0f4eb9599650d02fe928f0861f',
 'od-0e0322e97f2cd8799e6f5ca91868fec0ee724042',
 'od-4406172673f4a7221699b192705fccf9675e3b0f',
 'od-3a75ac2fcb642569e376273db0082724d3c8e670'
]);
const normalize = s => String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
export function formatEvidence(video, catalog=[]){
 const title=normalize(video.title), description=normalize(video.description);
 const own=['podcast-odysee','podcast-youtube'].includes(video.source_id);
 const tokens=s=>new Set(normalize(s).match(/[a-z]{4,}/g)||[]);
 const words=tokens(title);
 const references=(own?catalog:[]).filter(v=>v.id!==video.id && confirmed.has(v.id)).map(v=>{
   const other=tokens(v.title);
   const overlap=[...words].filter(w=>other.has(w)).length;
   return {id:v.id,title:v.title,owner_confirmed_format:'live',title_overlap:overlap,
     identical_thumbnail_url:!!video.thumbnail&&v.thumbnail===video.thumbnail};
 }).filter(v=>v.title_overlap>=3||v.identical_thumbnail_url).sort((a,b)=>b.title_overlap-a.title_overlap).slice(0,3);
 return {
   owner_confirmed_format:confirmed.has(video.id)?'live':null,
   owner_visual_observation:confirmed.has(video.id)?'Owner screenshot identifies this item as a truncated musical broadcast with the same thumbnail style as the live series.':null,
   source_context:own?'Owner reports Odysee imports mix episodes and broadcasts. Musical relaxation broadcasts can stop after seconds. Episodes usually, but not always, last under 30 minutes.':null,
   duration_over_30_minutes:Number(video.duration)>1800,
   musical_title:/musica|melodias|frecuencias|sonidos|piano/.test(title),
   relaxation_title:/calma|paz mental|paz interior|fortaleza interior|quietud|descanso|serenidad/.test(title),
   broadcast_title:/24\s*[/x]\s*7|en vivo|en directo|livestream/.test(title),
   broadcast_description:/transmision|transmisiones|en este directo|24\s*[/x]\s*7|pizarra en vivo/.test(description),
   episode_description:/en este episodio|este video|entrevista/.test(description),
   related_owner_confirmed_broadcasts:references,
   thumbnail_analysis:'No automatic pixel or visual-style analysis. URL equality only; screenshot observation is owner-provided.'
 };
}
