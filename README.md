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

## Content, by source
- **Fun facts (Wikipedia):** books, history, geography, science, food and
  how-it's-made pull **random** articles inside each theme (thousands per
  category) and lift out the most surprising sentence. New every day.
- **Cinema + People (TMDb):** real films and actors with posters and photos.
  Needs a free key — see below. Without a key, these two fall back to Wikipedia.
- **News (RSS):** mostly **film & book** news from well-known European,
  English-language outlets (The Guardian Film & Books, Cineuropa, BBC Culture),
  plus a little science. Only the **title + a few lines + a link** to the
  original — never the full article. A spoiler filter skips recap / "ending
  explained" pieces, and the film cards themselves use TMDb's official
  spoiler-free synopsis. Edit `NEWS_FEEDS` to add or swap outlets.
- **History:** also seeded by Wikipedia "On this day" (changes daily).
- **Videos:** a few short WebM clips from Wikimedia.
- **`seen.json`:** remembers what already appeared (committed each run) so
  nothing repeats. Created automatically on the first run.

### Turn on Cinema + People (free TMDb key)
1. Make a free account at themoviedb.org, then Settings -> API -> request a
   **Developer** key (it's free; for the app URL you can use your GitHub repo).
2. In your repo: Settings -> Secrets and variables -> Actions -> New secret,
   name `TMDB_API_KEY`, paste the key. That's it — the workflow already reads it.
3. Attribution is required by TMDb. If you ever make this public, add this line
   in an About/Credits area: *"This product uses the TMDB API but is not
   endorsed or certified by TMDB."* Cards already show TMDB as the source.

To change what a category pulls from, edit `CATEGORY_SOURCES` (Wikipedia) or
`NEWS_FEEDS` (news) in `fetch-content.mjs`.

## Making it sound human (not robotic)
Two modes in `fetch-content.mjs`:
- **Free (default):** each fact gets a warm opener + closing line.
- **LLM (opt-in):** a model rewrites each card. Set `USE_LLM=1` and add an
  `ANTHROPIC_API_KEY` repo secret (uncomment the `env` block in `update.yml`).
  Costs cents/day — the only non-free part.

## Costs
GitHub Pages, GitHub Actions (public repos), Wikimedia and Wikipedia are all
free and keyless. For a group of friends you won't get near any limit.
