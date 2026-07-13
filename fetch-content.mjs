// fetch-content.mjs
// Builds content.json (Node 18+, no npm install). Free, ad-free, self-updating.
//
// Sources:
//   - Wikipedia random-by-theme  -> fun-fact cards (books, history, geography,
//                                   science, food, how-it's-made)
//   - TMDb (free key)            -> Cinema + People cards (posters, photos)
//   - RSS (European, English)    -> News cards (title + a few lines + link only)
//   - Wikipedia "On this day"    -> extra history cards
//   - Wikimedia Commons video    -> a few native video clips
//
// seen.json remembers what already appeared so nothing repeats.
// Optional LLM rewrite: USE_LLM=1 + ANTHROPIC_API_KEY. TMDb needs TMDB_API_KEY.

import { writeFile, readFile } from "node:fs/promises";

// --------------------------------------------------------------------------- CONFIG
const CARDS_PER_CAT = 4, HISTORY_CARDS = 6, SEEN_CAP = 6000;
const UA = "SapioFeed/1.0 (friends learning project)";
const TMDB_KEY = process.env.TMDB_API_KEY || "";

// Wikipedia themes (cinema/people are used ONLY as fallback when no TMDb key).
const CATEGORY_SOURCES = {
  books:      ['deepcategory:"Novels"', 'novel OR author OR book'],
  history:    ['deepcategory:"Historical events"', 'history OR empire OR dynasty OR revolution'],
  geography:  ['deepcategory:"Landforms"', 'mountain OR river OR island OR desert OR volcano'],
  science:    ['deepcategory:"Physics"', 'deepcategory:"Biology"', 'physics OR chemistry OR astronomy OR species'],
  food:       ['deepcategory:"Foods"', 'dish OR cuisine OR dessert OR ingredient'],
  howitsmade: ['deepcategory:"Manufacturing"', '"is produced" OR "is made from" OR factory OR assembly'],
  cinema:     ['deepcategory:"Films by genre"', 'film OR movie'],
  people:     ['deepcategory:"Actors"', 'actor OR actress OR performer'],
};

// European, English-language outlets, weighted toward FILM & BOOKS.
// Only title + a few lines + link. `n` = how many items to take from each.
const NEWS_FEEDS = [
  { name: "The Guardian · Film",   url: "https://www.theguardian.com/film/rss",  n: 3 },
  { name: "The Guardian · Books",  url: "https://www.theguardian.com/books/rss", n: 3 },
  { name: "Cineuropa",             url: "https://cineuropa.org/en/rss",           n: 2 },
  { name: "BBC Culture",           url: "https://www.bbc.com/culture/feed.rss",   n: 2 },
  { name: "BBC Entertainment",     url: "https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml", n: 2 },
  { name: "New Scientist",         url: "https://www.newscientist.com/feed/home/", n: 1 },
  { name: "ESA",                   url: "https://www.esa.int/rssfeed/Our_Activities/Space_Science", n: 1 },
];
// Skip anything that self-labels as a spoiler / recap / ending-explained piece.
const SPOILER = /\b(spoilers?|ending explained|ending,? explained|recap|full plot|plot summary|who dies|dies in|death of|twist explained|finale explained|season finale|episode \d+|breakdown|explained:)\b/i;

const VIDEO_QUERIES = { science:["nasa animation"], geography:["earth timelapse"], howitsmade:["manufacturing process"] };
const VIDEOS_PER_CAT = 2, MAX_BYTES = 40_000_000;

// --------------------------------------------------------------------------- helpers
const OPENERS = ["File under 'wait, really?' —","Okay, this one's fun —","Small thing, surprisingly big deal —",
  "Here's one for the group chat —","You probably never noticed this —","Bet you didn't know —"];
const KICKERS = ["Worth a quiet trip down the rabbit hole.","Bring it up somewhere. Watch the reaction.",
  "One of those things you can't un-know.","The world is stranger than it lets on."];
const pick = (a,i)=>a[Math.abs(i)%a.length];
const shuffle = (a)=>{for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;};
const sentences = (t)=>(t||"").replace(/\s+/g," ").trim().split(/(?<=[.!?])\s/);
const stripTags = (s)=>(s||"").replace(/<[^>]+>/g,"").replace(/\s+/g," ").trim();
const cleanTitle = (t)=>(t||"").replace(/^File:/,"").replace(/\.[a-z0-9]+$/i,"").replace(/_/g," ").replace(/\s*\([^)]*\)\s*$/,"").trim();
const pick1 = (s,re)=>{const m=s.match(re);return m?m[1]:"";};
const decode = (s)=>(s||"").replace(/<!\[CDATA\[|\]\]>/g,"").replace(/<[^>]+>/g," ")
  .replace(/&amp;/g,"&").replace(/&#0?39;|&apos;/g,"'").replace(/&quot;/g,'"').replace(/&lt;/g,"<").replace(/&gt;/g,">")
  .replace(/&nbsp;/g," ").replace(/\s+/g," ").trim();

function funFact(extract){
  const s = sentences(extract).filter(x=>x.length>=35 && x.length<=240);
  const kw = /\b(first|only|oldest|largest|smallest|longest|highest|deepest|fastest|never|unlike|despite|actually|surprisingly|rare|unique|banned|originally|invented|accident|secret|world'?s|million|billion|thousand|centur|\d{3,})\b/i;
  let best=null, bs=-1;
  s.forEach((sen,i)=>{ let sc=0; if(kw.test(sen))sc+=3; if(/\d/.test(sen))sc+=1; if(i>0)sc+=0.5; if(sc>bs){bs=sc;best=sen;} });
  return best || s[0] || "";
}

// --------------------------------------------------------------------------- anti-repeat memory
let seen = new Set(); let seenOrder = []; const ADDED = [];
async function loadSeen(){ try{ seenOrder=JSON.parse(await readFile("seen.json","utf8")); seen=new Set(seenOrder); }catch{} }
async function saveSeen(){ const a=[...ADDED,...seenOrder].slice(0,SEEN_CAP); await writeFile("seen.json",JSON.stringify(a)); }

// --------------------------------------------------------------------------- Wikipedia
async function searchTitles(query, limit){
  const api=`https://en.wikipedia.org/w/api.php?action=query&format=json&list=search&srsearch=${encodeURIComponent(query)}&srsort=random&srlimit=${limit}&srnamespace=0`;
  try{ const r=await fetch(api,{headers:{"User-Agent":UA}}); if(!r.ok)throw 0; const d=await r.json(); return (d?.query?.search||[]).map(x=>x.title); }catch{ return []; }
}
async function fetchSummary(title){
  try{ const r=await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}?redirect=true`,{headers:{"User-Agent":UA}});
    if(!r.ok) return null; const d=await r.json();
    return { title:d.title, type:d.type, extract:d.extract, img:(d.thumbnail&&d.thumbnail.source)||null, url:d.content_urls?.desktop?.page||null }; }catch{ return null; }
}
async function fetchCategory(cat, queries){
  const cards=[], local=new Set();
  for(const q of shuffle(queries.slice())){
    if(cards.length>=CARDS_PER_CAT) break;
    for(const t of await searchTitles(q,20)){
      if(cards.length>=CARDS_PER_CAT) break;
      if(seen.has(t)||local.has(t)) continue; local.add(t);
      if(/^(List of|Index of|Timeline of|Outline of)\b|\(disambiguation\)/i.test(t)) continue;
      const s=await fetchSummary(t);
      if(!s||s.type!=="standard"||!s.extract||s.extract.length<150) continue;
      const hook=funFact(s.extract); if(!hook||hook.length<30) continue;
      const ctx=sentences(s.extract).find(x=>x!==hook&&x.length>25)||"";
      cards.push({ type:"card", cat, opener:pick(OPENERS,t.length), hook,
        body:`${ctx} ${pick(KICKERS,t.length)}`.trim().slice(0,260), img:s.img, src:"Wikipedia", url:s.url });
      ADDED.push(t);
    }
  }
  return cards;
}

// --------------------------------------------------------------------------- TMDb (Cinema + People)
async function tmdb(path, params={}){
  if(!TMDB_KEY) return null;
  const u=new URL("https://api.themoviedb.org/3"+path);
  u.searchParams.set("api_key",TMDB_KEY); u.searchParams.set("language","en-US");
  for(const k in params) u.searchParams.set(k, params[k]);
  try{ const r=await fetch(u,{headers:{"User-Agent":UA}}); if(!r.ok) return null; return await r.json(); }catch{ return null; }
}
const TMDB_IMG="https://image.tmdb.org/t/p/w500";
async function fetchCinema(n){
  const out=[]; const d=await tmdb("/discover/movie",{ sort_by:"popularity.desc", "vote_count.gte":800, include_adult:false, page:1+Math.floor(Math.random()*40) });
  for(const m of shuffle((d&&d.results)||[])){
    if(out.length>=n) break; const id="tmdb:movie:"+m.id;
    if(seen.has(id)||!m.overview||!m.poster_path) continue;
    const year=(m.release_date||"").slice(0,4);
    out.push({ type:"card", cat:"cinema", opener:"Worth adding to the watchlist —",
      hook:`${m.title}${year?` (${year})`:""}`, body:m.overview.replace(/\s+/g," ").trim().slice(0,240),
      img:TMDB_IMG+m.poster_path, src:"TMDB", url:`https://www.themoviedb.org/movie/${m.id}` });
    ADDED.push(id);
  }
  return out;
}
async function fetchPeople(n){
  const out=[]; const d=await tmdb("/person/popular",{ page:1+Math.floor(Math.random()*20) });
  for(const p of shuffle((d&&d.results)||[])){
    if(out.length>=n) break; const id="tmdb:person:"+p.id;
    if(seen.has(id)||!p.profile_path||!(p.known_for&&p.known_for.length)) continue;
    const known=p.known_for.map(k=>k.title||k.name).filter(Boolean).slice(0,3).join(", ");
    out.push({ type:"card", cat:"people", opener:"A face you know —", hook:p.name,
      body:known?`Known for ${known}.`:"", img:TMDB_IMG+p.profile_path, src:"TMDB", url:`https://www.themoviedb.org/person/${p.id}` });
    ADDED.push(id);
  }
  return out;
}

// --------------------------------------------------------------------------- News (RSS, title + few lines + link)
async function fetchNews(){
  const out=[];
  for(const f of NEWS_FEEDS){
    const limit=f.n||2;
    try{
      const r=await fetch(f.url,{headers:{"User-Agent":UA}}); if(!r.ok) continue;
      const xml=await r.text();
      const items=xml.split(/<item[ >]/).slice(1);
      let added=0;
      for(const it of items){
        if(added>=limit) break;
        const title=decode(pick1(it,/<title>([\s\S]*?)<\/title>/));
        let link=decode(pick1(it,/<link>([\s\S]*?)<\/link>/)) || decode(pick1(it,/<guid[^>]*>([\s\S]*?)<\/guid>/));
        const desc=decode(pick1(it,/<description>([\s\S]*?)<\/description>/));
        if(!title||!/^https?:/.test(link)) continue;
        if(SPOILER.test(`${title} ${desc}`)) continue;          // no spoilers
        const id="news:"+link; if(seen.has(id)) continue;
        const body=sentences(desc).slice(0,3).join(" ").slice(0,240);
        out.push({ type:"card", cat:"news", opener:`${f.name} —`, hook:title, body, src:f.name, url:link });
        ADDED.push(id); added++;
      }
    }catch{}
  }
  return out;
}

// --------------------------------------------------------------------------- Wikipedia "On this day"
async function fetchHistory(){
  const now=new Date(), mm=String(now.getUTCMonth()+1).padStart(2,"0"), dd=String(now.getUTCDate()).padStart(2,"0");
  try{ const r=await fetch(`https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${mm}/${dd}`,{headers:{"User-Agent":UA}}); if(!r.ok)throw 0; const d=await r.json();
    return shuffle((d.events||[]).filter(e=>e.pages&&e.pages[0]&&e.pages[0].extract)).slice(0,HISTORY_CARDS).map((e,i)=>({
      type:"card", cat:"history", opener:`On this day in ${e.year} —`, hook:e.text.replace(/\s+/g," ").trim(),
      body:`${sentences(e.pages[0].extract)[0]||""} ${pick(KICKERS,e.year+i)}`.trim(),
      img:(e.pages[0].thumbnail&&e.pages[0].thumbnail.source)||null, src:"Wikipedia · On this day", url:e.pages[0].content_urls?.desktop?.page||null }));
  }catch{ return []; }
}

// --------------------------------------------------------------------------- Wikimedia video
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
  for(const [cat,terms] of Object.entries(VIDEO_QUERIES)){ const seenU=new Set(), picked=[];
    for(const term of terms){ if(picked.length>=VIDEOS_PER_CAT) break;
      for(const v of await fetchCommons(term)){ if(picked.length>=VIDEOS_PER_CAT) break; if(seenU.has(v.src_url)) continue; seenU.add(v.src_url); picked.push({...v,cat}); } }
    out.push(...picked); }
  return out;
}

// --------------------------------------------------------------------------- optional LLM
async function humanizeWithLLM(cards){
  if(process.env.USE_LLM!=="1"||!process.env.ANTHROPIC_API_KEY) return cards;
  const out=[];
  for(const c of cards){
    if(c.cat==="news"){ out.push(c); continue; } // don't rewrite live news
    try{ const r=await fetch("https://api.anthropic.com/v1/messages",{ method:"POST",
      headers:{"content-type":"application/json","x-api-key":process.env.ANTHROPIC_API_KEY,"anthropic-version":"2023-06-01"},
      body:JSON.stringify({ model:"claude-haiku-4-5-20251001", max_tokens:220,
        system:"Turn this into a fun, surprising fact card. Keep it 100% accurate — invent nothing. Lead with the most curious angle. Return ONLY JSON: {\"opener\":\"short playful lead-in\",\"hook\":\"one punchy surprising sentence\",\"body\":\"2 short sentences of context\"}.",
        messages:[{role:"user",content:`Fact (do not add facts): "${c.hook}. ${c.body}"`}] }) });
      const d=await r.json(); const text=(d.content||[]).map(b=>b.text||"").join("");
      const j=JSON.parse(text.replace(/```json|```/g,"").trim());
      out.push({...c,opener:j.opener||c.opener,hook:j.hook||c.hook,body:j.body||c.body});
    }catch{ out.push(c); }
  }
  return out;
}

// --------------------------------------------------------------------------- main
(async()=>{
  await loadSeen();
  const topic=[];
  for(const [cat,queries] of Object.entries(CATEGORY_SOURCES)){
    if(TMDB_KEY && (cat==="cinema"||cat==="people")) continue; // TMDb handles these
    process.stdout.write(`  ${cat}… `); const c=await fetchCategory(cat,queries); topic.push(...c); console.log(`${c.length}`);
  }
  let cinemaPeople=[];
  if(TMDB_KEY){ console.log("TMDb cinema+people…"); cinemaPeople=[...await fetchCinema(CARDS_PER_CAT), ...await fetchPeople(CARDS_PER_CAT)]; }
  console.log("News (RSS)…");   const news=await fetchNews();
  console.log("On this day…");  const history=await fetchHistory();
  console.log("Videos…");       const videos=await fetchVideos();

  let cards = await humanizeWithLLM([...topic, ...cinemaPeople, ...history, ...news]);
  const items = shuffle([...videos, ...cards]);
  await writeFile("content.json", JSON.stringify({ generated:new Date().toISOString(), count:items.length, items }, null, 2));
  await saveSeen();
  console.log(`Wrote content.json — ${items.length} items (${news.length} news, ${videos.length} videos). +${ADDED.length} remembered.`);
})();
