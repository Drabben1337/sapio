# Sàpio

A small TikTok-style feed to get smarter with friends — vertical scroll, mixing
short **ad-free** videos with humanized fact cards. No user uploads, no
moderation, no server, no YouTube ads. Content refreshes itself for free.

## Files
- `index.html` — the app. Reads `content.json`; falls back to built-in samples.
- `fetch-content.mjs` — pulls fresh content (Wikimedia video + Wikipedia) → `content.json`.
- `.github/workflows/update.yml` — runs the fetch on a schedule (every 6h).
- `manifest.json`, `icon.svg` — makes it installable as a home-screen app.
- `.nojekyll` — empty file that stops GitHub Pages from touching your files.

## Try it now
Open `index.html`. It shows the sample feed with real ad-free NASA clips.

## Put it online (free)
1. Create a **public** GitHub repo and upload every file here.
2. Add the workflow by hand: *Add file → Create new file*, name it
   `.github/workflows/update.yml`, paste the file's contents, commit.
3. Settings → Pages → Source **Deploy from a branch**, Branch **main / (root)**, Save.
4. Actions tab → *Update content* → *Run workflow* (this creates `content.json`).
5. Open the URL on your phone → Share → **Add to Home Screen**.

> If step 4 fails on the commit with a permissions error: Settings → Actions →
> General → Workflow permissions → **Read and write permissions** → save → re-run.

## Why no ads now
Videos come from **Wikimedia Commons** (Creative Commons / public domain) and
play in a native `<video>` element — not a YouTube iframe. That removes ads
entirely, and audio stops the instant a clip scrolls out of view.

**Format note:** Commons only hosts open formats (WebM). Modern Android and
iPhones (iOS 16+) play WebM fine; very old devices may not. There's no legal way
to strip ads from YouTube embeds, which is why we changed the source instead.

## Content
- **Fun-fact cards:** for each of 8 categories (cinema, people, books, history,
  geography, science, food, how-it's-made) the script pulls **random** Wikipedia
  articles inside that theme, then lifts out the most surprising sentence. The
  pool is thousands of articles per category, so it's new every day.
- **`seen.json`:** a memory of titles already shown, committed each run, so
  facts don't repeat. It's created automatically on the first run.
- **History:** also seeded by Wikipedia "On this day" (changes daily).
- **Videos:** a few short WebM clips from Wikimedia.
- Each card links back to its Wikipedia article via "Read more".

To change what a category pulls from, edit `CATEGORY_SOURCES` in `fetch-content.mjs`.

## Making it sound human (not robotic)
Two modes in `fetch-content.mjs`:
- **Free (default):** each fact gets a warm opener + closing line.
- **LLM (opt-in):** a model rewrites each card. Set `USE_LLM=1` and add an
  `ANTHROPIC_API_KEY` repo secret (uncomment the `env` block in `update.yml`).
  Costs cents/day — the only non-free part.

## Costs
GitHub Pages, GitHub Actions (public repos), Wikimedia and Wikipedia are all
free and keyless. For a group of friends you won't get near any limit.
