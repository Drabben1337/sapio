// fetch-content.mjs
// Pulls fresh, ad-free "fun fact" content and writes content.json (Node 18+).
//
// How it stays new every day (no hand-written topic list):
//   For each category we ask Wikipedia for RANDOM articles inside that theme
//   (srsort=random over broad category queries) — a pool of thousands per topic.
//   seen.json remembers what already appeared, so nothing repeats.
//
// Sources (all free, keyless, no ads):
//   - Wikipedia search (random, by theme) -> fun-fact cards
//   - Wikipedia "On this day"             -> history cards
//   - Wikimedia Commons video (CC/PD)     -> a few native video cards
//
// Humanization: FREE by default (a surprising sentence is pulled out as the
// hook + a warm opener). Optional LLM rewrite: USE_LLM=1 + ANTHROPIC_API_KEY.

import { writeFile, readFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// CONFIG — 8 categories. Each lists Wikipedia queries; we pull random hits.
// deepcategory: walks a category tree (thousands of articles). The plain term
// at the end is a safe fallback. Tune freely.
// ---------------------------------------------------------------------------
const CATEGORY_SOURCES = {
  cinema:     ['deepcategory:"Films by genre"', 'deepcategory:"Film awards"', 'film OR movie OR screenplay'],
  people:     ['deepcategory:"Actors"', 'deepcategory:"Entertainers"', 'actor OR actress OR performer'],
  books:      ['deepcategory:"Novels"', 'deepcategory:"Literature"', 'novel OR author OR book'],
  history:    ['deepcategory:"Historical events"', 'deepcategory:"Ancient history"', 'history OR empire OR dynasty OR revolution'],
  geography:  ['deepcategory:"Landforms"', 'deepcategory:"Populated places"', 'mountain OR river OR island OR desert OR volcano'],
  science:    ['deepcategory:"Physics"', 'deepcategory:"Biology"', 'physics OR chemistry OR astronomy OR species'],
  food:       ['deepcategory:"Foods"', 'deepcategory:"Cuisine"', 'dish OR cuisine OR dessert OR beverage OR ingredient'],
  howitsmade: ['deepcategory:"Manufacturing"', 'deepcategory:"Industrial processes"', 'manufacturing OR "is produced" OR "is made from" OR factory'],
};
const CARDS_PER_CAT = 4;
const HISTORY_CARDS = 6;
const SEEN_CAP      = 5000;   // how many recent titles to remember (anti-repeat)
const UA = "SapioFeed/1.0 (friends learning project)";

const VIDEO_QUERIES = {
  science:   ["physics animation", "nasa animation"],
  geography: ["aerial landscape", "earth timelapse"],
  howitsmade:["manufacturing process", "assembly line"],
};
const VIDEOS_PER_CAT = 2;
const MAX_BYTES = 40_000_000;

// ---------------------------------------------------------------------------
// Humanization banks (free mode)
// ---------------------------------------------------------------------------
const OPENERS = ["File under 'wait, really?' —","Okay, this one's fun —","Small thing, surprisingly big deal —",
  "Here's one for the group chat —","You probably never noticed this —","Today's 'huh, neat' —","Bet you didn't know —"];
const KICKERS = ["Worth a quiet trip down the rabbit hole.","Bring it up somewhere. Watch the reaction.",
  "One of those things you can't un-know.","The world is stranger than it lets on."];
const pick = (a,i)=>a[Math.abs(i)%a.length];
const shuffle = (a)=>{for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;};
const sentences = (t)=>(t||"").replace(/\s+/g," ").trim().split(/(?<=[.!?])\s/);
const stripTags = (s)=>(s||"").replace(/<[^>]+>/g,"").replace(/\s+/g," ").trim();
const cleanTitle = (t)=>(t||"").replace(/^File:/,"").replace(/\.[a-z0-9]+$/i,"").replace(/_/g," ").replace(/\s*\([^)]*\)\s*$/,"").trim();

// Pull the most "fun fact"-ish sentence rather than the dry definition.
function funFact(extract){
  const s = sentences(extract).filter(x=>x.length>=35 && x.length<=240);
  const kw = /\b(first|only|oldest|largest|smallest|longest|highest|deepest|fastest|never|unlike|despite|actually|surprisingly|rare|unique|banned|originally|invented|accident|secret|world'?s|million|billion|thousand|centur|\d{3,})\b/i;
  let best=null, bs=-1;
  s.forEach((sen,i)=>{ let sc=0; if(kw.test(sen))sc+=3; if(/\d/.test(sen))sc+=1; if(i>0)sc+=0.5; if(sc>bs){bs=sc;best=sen;} });
  return best || s[0] || "";
}

// ---------------------------------------------------------------------------
// anti-repetition memory
// ---------------------------------------------------------------------------
let seen = new Set(); let seenOrder = [];
async function loadSeen(){ try{ const a=JSON.parse(await readFile("seen.json","utf8")); seenOrder=a; seen=new Set(a); }catch{} }
async function saveSeen(added){ let a=[...added,...seenOrder]; a=a.slice(0,SEEN_CAP); await writeFile("seen.json",JSON.stringify(a)); }

// ---------------------------------------------------------------------------
// Wikipedia random-by-theme search + summaries
// ---------------------------------------------------------------------------
async function searchTitles(query, limit){
  const api = `https://en.wikipedia.org/w/api.php?action=query&format=json&list=search`
    + `&srsearch=${encodeURIComponent(query)}&srsort=random&srlimit=${limit}&srnamespace=0`;
  try{ const r=await fetch(api,{headers:{"User-Agent":UA}}); if(!r.ok)throw 0;
    const d=await r.json(); return (d?.query?.search||[]).map(x=>x.title); }
  catch{ return []; }
}
async function fetchSummary(title){
  try{ const r=await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}?redirect=true`,{headers:{"User-Agent":UA}});
    if(!r.ok) return null; const d=await r.json();
    return { title:d.title, type:d.type, extract:d.extract,
      img:(d.thumbnail&&d.thumbnail.source)||null, url:d.content_urls?.desktop?.page||null }; }
  catch{ return null; }
}

async function fetchCategory(cat, queries){
  const cards=[], local=new Set(), added=[];
  for(const q of shuffle(queries.slice())){
    if(cards.length>=CARDS_PER_CAT) break;
    for(const t of await searchTitles(q, 20)){
      if(cards.length>=CARDS_PER_CAT) break;
      if(seen.has(t)||local.has(t)) continue; local.add(t);
      if(/^(List of|Index of|Timeline of|Outline of)\b|\(disambiguation\)/i.test(t)) continue;
      const s=await fetchSummary(t);
      if(!s||s.type!=="standard"||!s.extract||s.extract.length<150) continue;
      const hook=funFact(s.extract); if(!hook||hook.length<30) continue;
      const ctx=sentences(s.extract).find(x=>x!==hook&&x.length>25)||"";
      cards.push({ type:"card", cat, opener:pick(OPENERS,t.length),
        hook, body:`${ctx} ${pick(KICKERS,t.length)}`.trim().slice(0,260),
        img:s.img, src:"Wikipedia", url:s.url });
      added.push(t);
    }
  }
  return { cards, added };
}

// ---------------------------------------------------------------------------
// Wikipedia "On this day" -> history
// ---------------------------------------------------------------------------
async function fetchHistory(){
  const now=new Date(), mm=String(now.getUTCMonth()+1).padStart(2,"0"), dd=String(now.getUTCDate()).padStart(2,"0");
  try{ const r=await fetch(`https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${mm}/${dd}`,{headers:{"User-Agent":UA}});
    if(!r.ok)throw 0; const d=await r.json();
    return shuffle((d.events||[]).filter(e=>e.pages&&e.pages[0]&&e.pages[0].extract)).slice(0,HISTORY_CARDS).map((e,i)=>({
      type:"card", cat:"history", opener:`On this day in ${e.year} —`,
      hook:e.text.replace(/\s+/g," ").trim(),
      body:`${sentences(e.pages[0].extract)[0]||""} ${pick(KICKERS,e.year+i)}`.trim(),
      img:(e.pages[0].thumbnail&&e.pages[0].thumbnail.source)||null,
      src:"Wikipedia · On this day", url:e.pages[0].content_urls?.desktop?.page||null }));
  }catch{ return []; }
}

// ---------------------------------------------------------------------------
// Wikimedia Commons video (webm)
// ---------------------------------------------------------------------------
async function fetchCommons(term){
  const q=encodeURIComponent(`filemime:video/webm ${term}`);
  const api=`https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrsearch=${q}&gsrnamespace=6&gsrlimit=10&prop=imageinfo&iiprop=url|mime|size|extmetadata&iiurlwidth=640`;
  try{ const r=await fetch(api,{headers:{"User-Agent":UA}}); if(!r.ok)throw 0; const d=await r.json();
    return Object.values(d?.query?.pages||{}).map(p=>{ const info=p.imageinfo&&p.imageinfo[0];
      if(!info||info.mime!=="video/webm"||info.size>MAX_BYTES) return null; const meta=info.extmetadata||{};
      return { type:"video", src_url:info.url, poster:info.thumburl||null, ttl:cleanTitle(p.title),
        chan:stripTags(meta.Artist&&meta.Artist.value)||"Wikimedia Commons",
        src:`${stripTags(meta.LicenseShortName&&meta.LicenseShortName.value)||"CC"} · Wikimedia`, url:info.descriptionurl||null }; }).filter(Boolean);
  }catch{ return []; }
}
async function fetchVideos(){
  const out=[];
  for(const [cat,terms] of Object.entries(VIDEO_QUERIES)){
    const seenU=new Set(), picked=[];
    for(const term of shuffle(terms.slice())){ if(picked.length>=VIDEOS_PER_CAT) break;
      for(const v of await fetchCommons(term)){ if(picked.length>=VIDEOS_PER_CAT) break;
        if(seenU.has(v.src_url)) continue; seenU.add(v.src_url); picked.push({...v,cat}); } }
    out.push(...picked);
  }
  return out;
}

// ---------------------------------------------------------------------------
// OPTIONAL LLM rewrite (real fun-fact voice). USE_LLM=1 + ANTHROPIC_API_KEY.
// ---------------------------------------------------------------------------
async function humanizeWithLLM(cards){
  if(process.env.USE_LLM!=="1"||!process.env.ANTHROPIC_API_KEY) return cards;
  const out=[];
  for(const c of cards){
    try{ const r=await fetch("https://api.anthropic.com/v1/messages",{ method:"POST",
      headers:{"content-type":"application/json","x-api-key":process.env.ANTHROPIC_API_KEY,"anthropic-version":"2023-06-01"},
      body:JSON.stringify({ model:"claude-haiku-4-5-20251001", max_tokens:220,
        system:"Turn this into a fun, surprising fact card for a feed where friends learn something new. Keep it 100% accurate — invent nothing. Lead with the most curious angle. Return ONLY JSON: {\"opener\":\"short playful lead-in\",\"hook\":\"one punchy surprising sentence\",\"body\":\"2 short sentences of context\"}.",
        messages:[{role:"user",content:`Fact (do not add facts): "${c.hook}. ${c.body}"`}] }) });
      const d=await r.json(); const text=(d.content||[]).map(b=>b.text||"").join("");
      const j=JSON.parse(text.replace(/```json|```/g,"").trim());
      out.push({...c,opener:j.opener||c.opener,hook:j.hook||c.hook,body:j.body||c.body});
    }catch{ out.push(c); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async()=>{
  await loadSeen();
  const added=[];
  let topicCards=[];
  for(const [cat,queries] of Object.entries(CATEGORY_SOURCES)){
    process.stdout.write(`  ${cat}… `);
    const { cards, added:a } = await fetchCategory(cat,queries);
    topicCards.push(...cards); added.push(...a);
    console.log(`${cards.length} cards`);
  }
  console.log("On this day…");  const history = await fetchHistory();
  console.log("Videos…");       const videos  = await fetchVideos();

  let cards = await humanizeWithLLM([...topicCards, ...history]);
  const items = shuffle([...videos, ...cards]);

  await writeFile("content.json", JSON.stringify({ generated:new Date().toISOString(), count:items.length, items }, null, 2));
  await saveSeen(added);
  console.log(`Wrote content.json — ${items.length} items (${videos.length} videos). Remembered ${added.length} new titles.`);
})();
