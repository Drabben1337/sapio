# Sàpio

A small TikTok-style feed to get smarter with friends — vertical scroll, mixing
embedded YouTube videos with humanized fact cards. No user uploads, no
moderation, no server. Content refreshes itself for free.

## Files
- `index.html` — the app. Reads `content.json`; falls back to built-in samples.
- `fetch-content.mjs` — pulls fresh content (YouTube RSS + Wikipedia) → `content.json`.
- `.github/workflows/update.yml` — runs the fetch on a schedule (every 6h).
- `manifest.json`, `icon.svg` — makes it installable as a home-screen app.

## Try it now
Just open `index.html`. It shows the sample feed (fetching is skipped on `file://`).

## Put it online (free)
1. Create a **public** GitHub repo and upload these files.
2. Settings → Pages → deploy from branch `main`, folder `/root`. You get a URL.
3. Open the URL on your phone → Share → **Add to Home Screen**. Done.

> iOS home-screen icons need PNGs. Export `icon.svg` to `icon-192.png` and
> `icon-512.png` (any image tool) and drop them next to `index.html`.

## Turn on auto-updates (free)
The workflow is already set up. Once the repo is public:
- It runs every 6 hours and commits a fresh `content.json`.
- Run it once by hand: repo → **Actions** → *Update content* → *Run workflow*.

Add your own channels in `fetch-content.mjs` (the `CHANNELS` list). To get a
`channel_id`: open the channel page, View Source, search for `channelId`.

## About the content
- **Videos** come from YouTube channel RSS feeds — always the newest uploads,
  keyless and unlimited. (RSS can't tell Shorts from regular uploads; both embed
  the same, so it doesn't matter for the feed.)
- **History cards** come from Wikipedia's "On this day", so they change daily.
- Text under CC BY-SA from Wikipedia is linked back to the source on each card.

## Making it sound human (not robotic)
Two modes, both in `fetch-content.mjs`:
- **Free (default):** each fact is wrapped in a warm opener + a closing line, so
  it reads like a person, not an encyclopedia entry.
- **LLM (opt-in):** a model rewrites each card into a natural voice. Set
  `USE_LLM=1` and add an `ANTHROPIC_API_KEY` repo secret (uncomment the `env`
  block in `update.yml`). At a few cards a day this costs cents. It's the only
  part that isn't free — everything else stays at $0.

## Costs
GitHub Actions (public repos) and GitHub Pages are free. YouTube RSS and
Wikipedia are keyless and free. For a group of friends you won't get near any
limit. The only optional cost is the LLM rewrite above.
