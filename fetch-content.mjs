import { writeFile, readFile } from "node:fs/promises";

const CARDS_PER_CAT = 5, HISTORY_CARDS = 6, SEEN_CAP = 6000;
const FEED_TARGET = 48;   // mix: ~50% facts, ~35% cinema+books, ~15% news
const UA = "Sapio/1.0";
const TMDB_KEY = process.env.TMDB_API_KEY || "";

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

const NEWS_FEEDS = [
  { name:"The Guardian · Film",    url:"https://www.theguardian.com/film/rss",    n:10 },
  { name:"The Guardian · Books",   url:"https://www.theguardian.com/books/rss",   n:10 },
  { name:"The Guardian · Culture", url:"https://www.theguardian.com/culture/rss", n:8 },
  { name:"Cineuropa",              url:"https://cineuropa.org/en/rss",             n:10 },
  { name:"Screen Daily",           url:"https://www.screendaily.com/45202.rss",    n:6 },
  { name:"BBC Entertainment",      url:"https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml", n:8 },
  { name:"New Scientist",          url:"https://www.newscientist.com/feed/home/",  n:4 },
  { name:"ESA",                    url:"https://www.esa.int/rssfeed/Our_Activities/Space_Science", n:2 },
];
const NEWS_KEEP = 60;
const SPOILER = /\b(spoilers?|ending explained|ending,? explained|recap|full plot|plot summary|who dies|dies in|death of|twist explained|finale explained|season finale|episode \d+|breakdown|explained:)\b/i;
const BOOK_SPOILER = /\b(ending|dies|is killed|killed by|murder|reveals that|turns out|final chapter|last chapter|the killer|culprit|twist|suicide|death of)\b/i;

const VIDEO_QUERIES = { science:["nasa animation"], geography:["earth timelapse"], howitsmade:["manufacturing process"] };
const VIDEOS_PER_CAT = 2, MAX_BYTES = 40_000_000;

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

let seen = new Set(); let seenOrder = []; const ADDED = [];
async function loadSeen(){ try{ seenOrder=JSON.parse(await readFile("seen.json","utf8")); seen=new Set(seenOrder); }catch{} }
async function loadArchive(){ try{ return JSON.parse(await readFile("news-archive.json","utf8")); }catch{ return []; } }
async function saveArchive(a){ await writeFile("news-archive.json", JSON.stringify(a,null,2)); }
async function saveSeen(){ const a=[...ADDED,...seenOrder].slice(0,SEEN_CAP); await writeFile("seen.json",JSON.stringify(a)); }

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
      let hook, ctx;
      if(cat==="books"){
        const ss=sentences(s.extract);
        hook=ss[0];
        ctx=ss.slice(1).find(x=>x.length>25 && !BOOK_SPOILER.test(x)) || "";
      } else {
        hook=funFact(s.extract);
        ctx=sentences(s.extract).find(x=>x!==hook && x.length>25) || "";
      }
      if(!hook||hook.length<30) continue;
      cards.push({ type:"card", cat, opener:pick(OPENERS,t.length), hook,
        body:`${ctx} ${pick(KICKERS,t.length)}`.trim().slice(0,260), img:s.img, src:"Wikipedia", url:s.url });
      ADDED.push(t);
    }
  }
  return cards;
}

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

async function fetchNews(){
  const out=[], localLinks=new Set();
  for(const f of NEWS_FEEDS){
    const limit=f.n||2;
    try{
      const r=await fetch(f.url,{headers:{"User-Agent":UA}}); if(!r.ok) continue;
      const xml=await r.text();
      const items=xml.split(/<(?:item|entry)[ >]/).slice(1);
      let added=0;
      for(const it of items){
        if(added>=limit) break;
        const title=decode(pick1(it,/<title[^>]*>([\s\S]*?)<\/title>/));
        let link=decode(pick1(it,/<link>([\s\S]*?)<\/link>/));
        if(!/^https?:/.test(link)) link=pick1(it,/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/)||pick1(it,/<link[^>]*href="([^"]+)"/);
        if(!/^https?:/.test(link)) link=decode(pick1(it,/<guid[^>]*>([\s\S]*?)<\/guid>/));
        const desc=decode(pick1(it,/<(?:description|summary|content)[^>]*>([\s\S]*?)<\/(?:description|summary|content)>/));
        if(!title||!/^https?:/.test(link)||localLinks.has(link)) continue;
        if(SPOILER.test(`${title} ${desc}`)) continue;
        localLinks.add(link);
        const body=sentences(desc).slice(0,3).join(" ").slice(0,240);
        out.push({ type:"card", cat:"news", opener:`${f.name} —`, hook:title, body, src:f.name, url:link });
        added++;
      }
    }catch{}
  }
  return out;
}

async function fetchHistory(){
  const now=new Date(), mm=String(now.getUTCMonth()+1).padStart(2,"0"), dd=String(now.getUTCDate()).padStart(2,"0");
  try{ const r=await fetch(`https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${mm}/${dd}`,{headers:{"User-Agent":UA}}); if(!r.ok)throw 0; const d=await r.json();
    return shuffle((d.events||[]).filter(e=>e.pages&&e.pages[0]&&e.pages[0].extract)).slice(0,HISTORY_CARDS).map((e,i)=>({
      type:"card", cat:"history", opener:`On this day in ${e.year} —`, hook:e.text.replace(/\s+/g," ").trim(),
      body:`${sentences(e.pages[0].extract)[0]||""} ${pick(KICKERS,e.year+i)}`.trim(),
      img:(e.pages[0].thumbnail&&e.pages[0].thumbnail.source)||null, src:"Wikipedia · On this day", url:e.pages[0].content_urls?.desktop?.page||null }));
  }catch{ return []; }
}

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

async function humanizeWithLLM(cards){
  if(process.env.USE_LLM!=="1"||!process.env.ANTHROPIC_API_KEY) return cards;
  const out=[];
  for(const c of cards){
    if(c.type!=="card"||c.cat==="news"){ out.push(c); continue; }
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

(async()=>{
  await loadSeen();
  const topic=[];
  for(const [cat,queries] of Object.entries(CATEGORY_SOURCES)){
    if(TMDB_KEY && (cat==="cinema"||cat==="people")) continue;
    process.stdout.write(`  ${cat}… `); const c=await fetchCategory(cat,queries); topic.push(...c); console.log(`${c.length}`);
  }
  let cinemaPeople=[];
  if(TMDB_KEY){ console.log("TMDb cinema+people…"); cinemaPeople=[...await fetchCinema(8), ...await fetchPeople(6)]; }
  console.log("News (RSS)…");   const freshNews=await fetchNews();
  console.log("On this day…");  const history=await fetchHistory();
  console.log("Videos…");       const videos=await fetchVideos();

  const archive=await loadArchive();
  const known=new Set(archive.map(x=>x.url));
  const merged=[...freshNews.filter(x=>!known.has(x.url)).map(x=>({...x,_t:Date.now()})), ...archive].slice(0, NEWS_KEEP);
  await saveArchive(merged);
  const news=merged.map(({_t,...c})=>c);

  const knowledge=new Set(["science","geography","food","howitsmade","history"]);
  const cinemaPeopleCards = TMDB_KEY ? cinemaPeople : topic.filter(c=>c.cat==="cinema"||c.cat==="people");
  let facts   = shuffle([...topic.filter(c=>knowledge.has(c.cat)), ...history, ...videos]);
  let culture = shuffle([...cinemaPeopleCards, ...topic.filter(c=>c.cat==="books")]);
  facts   = await humanizeWithLLM(facts);
  culture = await humanizeWithLLM(culture);

  const T=FEED_TARGET;
  const nF=Math.round(T*0.50), nC=Math.round(T*0.35), nN=Math.round(T*0.15);
  const items = shuffle([ ...facts.slice(0,nF), ...culture.slice(0,nC), ...news.slice(0,nN) ]);
  await writeFile("content.json", JSON.stringify({ generated:new Date().toISOString(), count:items.length, items }, null, 2));
  await saveSeen();
  console.log(`Wrote content.json — ${items.length} items (${Math.min(facts.length,nF)} facts, ${Math.min(culture.length,nC)} cinema/books, ${Math.min(news.length,nN)} news).`);
})();
