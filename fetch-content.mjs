// fetch-content.mjs
// Pulls fresh, ad-free content and writes content.json (Node 18+, no npm install).
//
// Sources (all free, keyless, no ads):
//   - Wikimedia Commons video (CC / public domain) -> native video cards
//   - Wikipedia "On this day"                       -> humanized history cards
//
// Humanization: FREE by default (warm opener + kicker). Optional LLM rewrite
// if you set USE_LLM=1 and ANTHROPIC_API_KEY (see README).

import { writeFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const CATEGORY_QUERIES = {
  science:   ["physics animation", "chemistry reaction", "cell microscope", "nasa animation"],
  geography: ["aerial landscape", "earth timelapse", "volcano eruption", "ocean waves"],
  history:   ["historical footage", "archival newsreel", "1960s"],
  // "books" has almost no video on Commons — it stays card-only, which is fine.
};
const VIDEOS_PER_CAT = 3;
const MAX_BYTES      = 35_000_000;  // skip anything heavier than ~35 MB
const HISTORY_CARDS  = 4;
const UA = "SapioFeed/1.0 (friends learning project)"; // Wikimedia asks for a UA

// ---------------------------------------------------------------------------
// Humanization banks (free mode)
// ---------------------------------------------------------------------------
const OPENERS = [
  "Let this one mess with your sense of time —",
  "File under 'wait, really?' —",
  "Small thing, surprisingly big deal —",
  "Here's one for the group chat —",
  "Okay, picture this —",
];
const KICKERS = [
  "Worth a quiet trip down the rabbit hole.",
  "Bring it up somewhere. Watch the reaction.",
  "History is stranger than it lets on.",
  "One of those things you can't un-know.",
];
const pick = (a, seed) => a[Math.abs(seed) % a.length];
const firstSentence = (t) =>
  (t || "").replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] || "";
const stripTags = (s) => (s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const cleanTitle = (t) =>
  (t || "").replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, "")
    .replace(/_/g, " ").replace(/\s*\([^)]*\)\s*$/, "").trim();

// ---------------------------------------------------------------------------
// Wikimedia Commons video (webm only — plays natively, no ads, no iframe)
// ---------------------------------------------------------------------------
async function fetchCommons(term) {
  const q = encodeURIComponent(`filemime:video/webm ${term}`);
  const api = `https://commons.wikimedia.org/w/api.php?action=query&format=json`
    + `&generator=search&gsrsearch=${q}&gsrnamespace=6&gsrlimit=6`
    + `&prop=imageinfo&iiprop=url|mime|size|extmetadata&iiurlwidth=640`;
  try {
    const res = await fetch(api, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const pages = Object.values(data?.query?.pages || {});
    return pages.map((p) => {
      const info = p.imageinfo && p.imageinfo[0];
      if (!info || info.mime !== "video/webm" || info.size > MAX_BYTES) return null;
      const meta = info.extmetadata || {};
      return {
        type: "video",
        src_url: info.url,
        poster: info.thumburl || null,
        ttl: cleanTitle(p.title),
        chan: stripTags(meta.Artist && meta.Artist.value) || "Wikimedia Commons",
        src: `${stripTags(meta.LicenseShortName && meta.LicenseShortName.value) || "CC"} · Wikimedia`,
        url: info.descriptionurl || null,
      };
    }).filter(Boolean);
  } catch (err) {
    console.warn(`  ! Commons "${term}" failed: ${err.message}`);
    return [];
  }
}

async function fetchVideos() {
  const out = [];
  for (const [cat, terms] of Object.entries(CATEGORY_QUERIES)) {
    const seen = new Set();
    const picked = [];
    for (const term of terms) {
      if (picked.length >= VIDEOS_PER_CAT) break;
      for (const v of await fetchCommons(term)) {
        if (picked.length >= VIDEOS_PER_CAT) break;
        if (seen.has(v.src_url)) continue;
        seen.add(v.src_url);
        picked.push({ ...v, cat });
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
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const url = `https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${mm}/${dd}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const events = (data.events || [])
      .filter((e) => e.pages && e.pages[0] && e.pages[0].extract)
      .sort(() => Math.random() - 0.5)
      .slice(0, HISTORY_CARDS);
    return events.map((e, i) => {
      const page = e.pages[0];
      return {
        type: "card",
        cat: "history",
        opener: `On this day in ${e.year} —`,
        hook: e.text.replace(/\s+/g, " ").trim(),
        body: `${firstSentence(page.extract)} ${pick(KICKERS, e.year + i)}`.trim(),
        src: "Wikipedia · On this day",
        url: page.content_urls?.desktop?.page || null,
      };
    });
  } catch (err) {
    console.warn(`  ! Wikipedia feed failed: ${err.message}`);
    return [];
  }
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
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001", max_tokens: 220,
          system:
            "Rewrite one true fact into a warm, curious feed card. Keep every " +
            "fact accurate — invent nothing. Return ONLY JSON: {\"opener\":\"short " +
            "warm lead-in\",\"hook\":\"one punchy sentence\",\"body\":\"2 short " +
            "sentences of context, human tone\"}.",
          messages: [{ role: "user", content: `Fact (do not add facts): "${c.hook}. ${c.body}"` }],
        }),
      });
      const data = await res.json();
      const text = (data.content || []).map((b) => b.text || "").join("");
      const j = JSON.parse(text.replace(/```json|```/g, "").trim());
      out.push({ ...c, opener: j.opener || c.opener, hook: j.hook || c.hook, body: j.body || c.body });
    } catch { out.push(c); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  console.log("Fetching Wikimedia videos…");
  const videos = await fetchVideos();
  console.log("Fetching history cards…");
  let cards = await fetchHistory();
  cards = await humanizeWithLLM(cards);

  const items = [...videos, ...cards];
  const payload = { generated: new Date().toISOString(), count: items.length, items };
  await writeFile("content.json", JSON.stringify(payload, null, 2));
  console.log(`Wrote content.json — ${videos.length} videos, ${cards.length} cards.`);
})();
