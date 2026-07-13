// fetch-content.mjs
// Pulls fresh, ad-free content and writes content.json (Node 18+, no npm install).
//
// Sources (all free, keyless, no ads):
//   - Wikimedia Commons video (CC / public domain) -> native video cards
//   - Wikipedia "On this day"                       -> history cards (rotates daily)
//   - Wikipedia topic summaries                     -> science/geography/books cards
//
// Humanization: FREE by default (warm opener + kicker). Optional LLM rewrite
// if you set USE_LLM=1 and ANTHROPIC_API_KEY (see README).

import { writeFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// CONFIG — turn these up for a bigger feed.
// ---------------------------------------------------------------------------
const VIDEO_QUERIES = {
  science:   ["physics animation", "chemistry reaction", "cell microscope", "nasa animation"],
  geography: ["aerial landscape", "earth timelapse", "volcano eruption", "ocean waves"],
  history:   ["historical footage", "archival newsreel", "1960s"],
};
const VIDEOS_PER_CAT = 5;
const MAX_BYTES      = 40_000_000;
const HISTORY_CARDS  = 10;
const TOPICS_PER_CAT = 6;

// Topic library for card facts. Add as many titles as you like — they're
// shuffled each run, so the feed keeps changing. (Exact Wikipedia article titles.)
const TOPICS = {
  science: ["Tardigrade","Neutron star","Photosynthesis","Black hole","CRISPR","Quantum entanglement",
    "Mitochondrion","Antibiotic resistance","Bioluminescence","Superconductivity","Plate tectonics",
    "Immune system","Antimatter","Slime mould","Mantis shrimp","Placebo","Absolute zero"],
  geography: ["Mariana Trench","Sahara","Ring of Fire","Amazon River","Mount Everest","Caspian Sea",
    "Great Barrier Reef","Antarctica","Lake Baikal","Atacama Desert","Strait of Gibraltar","Danakil Depression",
    "Point Nemo","Bermuda Triangle","Fjord","Aral Sea","Socotra"],
  books: ["Don Quixote","One Thousand and One Nights","Epic of Gilgamesh","The Great Gatsby","War and Peace",
    "Ulysses (novel)","Divine Comedy","Frankenstein","The Odyssey","Beowulf","In Search of Lost Time",
    "Moby-Dick","Nineteen Eighty-Four","The Name of the Rose","Voynich manuscript","Codex Seraphinianus"],
};
const UA = "SapioFeed/1.0 (friends learning project)";

// ---------------------------------------------------------------------------
// Humanization banks (free mode)
// ---------------------------------------------------------------------------
const OPENERS = ["Let this one mess with your sense of time —","File under 'wait, really?' —",
  "Small thing, surprisingly big deal —","Here's one for the group chat —","Okay, picture this —",
  "You probably walked past this idea a hundred times —"];
const KICKERS = ["Worth a quiet trip down the rabbit hole.","Bring it up somewhere. Watch the reaction.",
  "One of those things you can't un-know.","The world is stranger than it lets on."];
const pick = (a, i) => a[Math.abs(i) % a.length];
const shuffle = (a) => { for (let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; };
const sentences = (t) => (t||"").replace(/\s+/g," ").trim().split(/(?<=[.!?])\s/);
const stripTags = (s) => (s||"").replace(/<[^>]+>/g,"").replace(/\s+/g," ").trim();
const cleanTitle = (t) => (t||"").replace(/^File:/,"").replace(/\.[a-z0-9]+$/i,"").replace(/_/g," ").replace(/\s*\([^)]*\)\s*$/,"").trim();

// ---------------------------------------------------------------------------
// Wikimedia Commons video (webm only)
// ---------------------------------------------------------------------------
async function fetchCommons(term) {
  const q = encodeURIComponent(`filemime:video/webm ${term}`);
  const api = `https://commons.wikimedia.org/w/api.php?action=query&format=json`
    + `&generator=search&gsrsearch=${q}&gsrnamespace=6&gsrlimit=12`
    + `&prop=imageinfo&iiprop=url|mime|size|extmetadata&iiurlwidth=640`;
  try {
    const res = await fetch(api, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Object.values(data?.query?.pages || {}).map((p) => {
      const info = p.imageinfo && p.imageinfo[0];
      if (!info || info.mime !== "video/webm" || info.size > MAX_BYTES) return null;
      const meta = info.extmetadata || {};
      return { type:"video", src_url:info.url, poster:info.thumburl||null, ttl:cleanTitle(p.title),
        chan: stripTags(meta.Artist&&meta.Artist.value) || "Wikimedia Commons",
        src: `${stripTags(meta.LicenseShortName&&meta.LicenseShortName.value)||"CC"} · Wikimedia`,
        url: info.descriptionurl||null };
    }).filter(Boolean);
  } catch (err) { console.warn(`  ! Commons "${term}": ${err.message}`); return []; }
}
async function fetchVideos() {
  const out = [];
  for (const [cat, terms] of Object.entries(VIDEO_QUERIES)) {
    const seen = new Set(), picked = [];
    for (const term of shuffle(terms.slice())) {
      if (picked.length >= VIDEOS_PER_CAT) break;
      for (const v of await fetchCommons(term)) {
        if (picked.length >= VIDEOS_PER_CAT) break;
        if (seen.has(v.src_url)) continue;
        seen.add(v.src_url); picked.push({ ...v, cat });
      }
    }
    out.push(...picked);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wikipedia "On this day" -> history cards
// ---------------------------------------------------------------------------
async function fetchHistory() {
  const now = new Date();
  const mm = String(now.getUTCMonth()+1).padStart(2,"0");
  const dd = String(now.getUTCDate()).padStart(2,"0");
  try {
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${mm}/${dd}`, { headers:{ "User-Agent":UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const events = shuffle((data.events||[]).filter((e)=>e.pages&&e.pages[0]&&e.pages[0].extract)).slice(0, HISTORY_CARDS);
    return events.map((e,i)=>({ type:"card", cat:"history",
      opener:`On this day in ${e.year} —`,
      hook:e.text.replace(/\s+/g," ").trim(),
      body:`${sentences(e.pages[0].extract)[0]||""} ${pick(KICKERS,e.year+i)}`.trim(),
      src:"Wikipedia · On this day", url:e.pages[0].content_urls?.desktop?.page||null }));
  } catch (err) { console.warn(`  ! On this day: ${err.message}`); return []; }
}

// ---------------------------------------------------------------------------
// Wikipedia topic summaries -> science / geography / books cards
// ---------------------------------------------------------------------------
async function fetchSummary(title) {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}?redirect=true`;
  try {
    const res = await fetch(url, { headers:{ "User-Agent":UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    if (!d.extract) return null;
    const s = sentences(d.extract);
    return { hook:s[0], body:(s.slice(1,3).join(" ")||"").trim(),
      src:"Wikipedia", url:d.content_urls?.desktop?.page||null };
  } catch { return null; }
}
async function fetchTopics() {
  const out = [];
  for (const [cat, titles] of Object.entries(TOPICS)) {
    const chosen = shuffle(titles.slice()).slice(0, TOPICS_PER_CAT);
    for (let i=0;i<chosen.length;i++) {
      const s = await fetchSummary(chosen[i]);
      if (!s) continue;
      out.push({ type:"card", cat, opener:pick(OPENERS,chosen[i].length+i),
        hook:s.hook, body:`${s.body} ${pick(KICKERS,i)}`.trim(), src:s.src, url:s.url });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// OPTIONAL: LLM rewrite. USE_LLM=1 + ANTHROPIC_API_KEY. ~cents/day. See README.
// ---------------------------------------------------------------------------
async function humanizeWithLLM(cards) {
  if (process.env.USE_LLM !== "1" || !process.env.ANTHROPIC_API_KEY) return cards;
  const out = [];
  for (const c of cards) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{ "content-type":"application/json", "x-api-key":process.env.ANTHROPIC_API_KEY, "anthropic-version":"2023-06-01" },
        body:JSON.stringify({ model:"claude-haiku-4-5-20251001", max_tokens:220,
          system:"Rewrite one true fact into a warm, curious feed card. Keep every fact accurate — invent nothing. Return ONLY JSON: {\"opener\":\"short warm lead-in\",\"hook\":\"one punchy sentence\",\"body\":\"2 short sentences of context, human tone\"}.",
          messages:[{ role:"user", content:`Fact (do not add facts): "${c.hook}. ${c.body}"` }] }),
      });
      const data = await res.json();
      const text = (data.content||[]).map((b)=>b.text||"").join("");
      const j = JSON.parse(text.replace(/```json|```/g,"").trim());
      out.push({ ...c, opener:j.opener||c.opener, hook:j.hook||c.hook, body:j.body||c.body });
    } catch { out.push(c); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  console.log("Fetching videos…");   const videos = await fetchVideos();
  console.log("Fetching history…");  const history = await fetchHistory();
  console.log("Fetching topics…");   const topics = await fetchTopics();
  let cards = await humanizeWithLLM([...history, ...topics]);

  const items = shuffle([...videos, ...cards]);
  const payload = { generated:new Date().toISOString(), count:items.length, items };
  await writeFile("content.json", JSON.stringify(payload, null, 2));
  console.log(`Wrote content.json — ${videos.length} videos, ${cards.length} cards (${items.length} total).`);
})();
