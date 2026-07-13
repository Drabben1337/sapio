// fetch-content.mjs
// Pulls fresh content from free sources and writes content.json.
// Runs on Node 18+ (uses the built-in fetch). No npm install needed.
//
// Sources:
//   - YouTube channel RSS  (keyless, unlimited)  -> video cards
//   - Wikipedia "On this day" (keyless)          -> humanized history cards
//
// Humanization has two modes:
//   FREE (default): wraps each fact in a warm opener + kicker so it reads
//                   like a person talking, not an encyclopedia.
//   LLM  (opt-in) : set USE_LLM=1 and ANTHROPIC_API_KEY to have a model
//                   rewrite each card. Costs a few cents a day. See README.

import { writeFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// CONFIG — add your own channels here. Get a channel_id from the channel page
// (View source -> search "channelId") or a site like commentpicker.com.
// Category must be one of: books | science | history | geography
// ---------------------------------------------------------------------------
const CHANNELS = [
  { id: "UCsXVk37bltHxD1rDPwtNM8Q", name: "Kurzgesagt",  cat: "science" },
  { id: "UCHnyfMqiRRG1u-2MsSQLbXA", name: "Veritasium",  cat: "science" },
  // Add more, e.g. RealLifeLore (geography), a history channel, a books channel:
  // { id: "UC...", name: "RealLifeLore", cat: "geography" },
];

const VIDEOS_PER_CHANNEL = 3;   // newest N uploads from each channel
const HISTORY_CARDS      = 4;    // how many "On this day" cards to keep
const UA = "SapioFeed/1.0 (friends learning project)"; // Wikipedia wants a UA

// ---------------------------------------------------------------------------
// Humanization banks (free mode)
// ---------------------------------------------------------------------------
const OPENERS = [
  "Let this one mess with your sense of time —",
  "File under 'wait, really?' —",
  "Small thing, surprisingly big deal —",
  "Here's one for the group chat —",
  "Okay, picture this —",
  "The kind of fact that reorganizes your afternoon —",
];
const KICKERS = [
  "Worth a quiet trip down the rabbit hole.",
  "Bring it up somewhere. Watch the reaction.",
  "History is stranger than it lets on.",
  "One of those things you can't un-know.",
];
const pick = (arr, seed) => arr[Math.abs(seed) % arr.length];
const firstSentence = (t) =>
  (t || "").replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] || "";

// ---------------------------------------------------------------------------
// YouTube RSS
// ---------------------------------------------------------------------------
async function fetchYouTube(channel) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.id}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const entries = xml.split("<entry>").slice(1);
    const decode = (s) =>
      s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
       .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    return entries.slice(0, VIDEOS_PER_CHANNEL).map((e) => {
      const id  = (e.match(/<yt:videoId>(.+?)<\/yt:videoId>/) || [])[1];
      const ttl = decode((e.match(/<title>(.+?)<\/title>/) || [])[1] || "");
      const pub = (e.match(/<published>(.+?)<\/published>/) || [])[1] || "";
      return id
        ? { type: "video", cat: channel.cat, id, ttl, chan: channel.name,
            src: `${channel.name} (YouTube)`, published: pub }
        : null;
    }).filter(Boolean);
  } catch (err) {
    console.warn(`  ! ${channel.name} feed failed: ${err.message}`);
    return [];
  }
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
      .sort(() => Math.random() - 0.5)   // vary which ones surface each run
      .slice(0, HISTORY_CARDS);

    return events.map((e, i) => {
      const page = e.pages[0];
      const link = page.content_urls?.desktop?.page || null;
      return {
        type: "card",
        cat: "history",
        opener: `On this day in ${e.year} —`,
        hook: e.text.replace(/\s+/g, " ").trim(),
        body: `${firstSentence(page.extract)} ${pick(KICKERS, e.year + i)}`.trim(),
        src: "Wikipedia · On this day",
        url: link,
      };
    });
  } catch (err) {
    console.warn(`  ! Wikipedia feed failed: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// OPTIONAL: rewrite cards with an LLM so they sound genuinely human.
// Enable by setting env: USE_LLM=1 and ANTHROPIC_API_KEY=sk-...
// Skips silently if not configured. Costs ~cents/day at this volume.
// ---------------------------------------------------------------------------
async function humanizeWithLLM(cards) {
  if (process.env.USE_LLM !== "1" || !process.env.ANTHROPIC_API_KEY) return cards;
  const model = "claude-haiku-4-5-20251001";
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
          model, max_tokens: 220,
          system:
            "You rewrite one true fact into a warm, curious card for a feed that " +
            "helps friends learn. Keep every fact accurate — invent nothing. " +
            "Return ONLY JSON: {\"opener\":\"short warm lead-in\",\"hook\":\"one " +
            "punchy sentence\",\"body\":\"2 short sentences of context, human tone\"}.",
          messages: [{
            role: "user",
            content: `Fact source (do not add facts): "${c.hook}. ${c.body}"`,
          }],
        }),
      });
      const data = await res.json();
      const text = (data.content || []).map((b) => b.text || "").join("");
      const j = JSON.parse(text.replace(/```json|```/g, "").trim());
      out.push({ ...c, opener: j.opener || c.opener, hook: j.hook || c.hook, body: j.body || c.body });
    } catch {
      out.push(c); // if a rewrite fails, keep the free version
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  console.log("Fetching videos…");
  const videoGroups = await Promise.all(CHANNELS.map(fetchYouTube));
  const videos = videoGroups.flat();

  console.log("Fetching history cards…");
  let cards = await fetchHistory();
  cards = await humanizeWithLLM(cards);

  const items = [...videos, ...cards];
  const payload = { generated: new Date().toISOString(), count: items.length, items };

  await writeFile("content.json", JSON.stringify(payload, null, 2));
  console.log(`Wrote content.json — ${videos.length} videos, ${cards.length} cards.`);
})();
