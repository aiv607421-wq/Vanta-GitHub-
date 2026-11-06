# VANTA — auto-updating via GitHub Actions (no server)

GitHub runs `scripts/update.js` every 6 hours, which finds new movies / TV / anime, links them to the players
(VidSpark, VidSrc, VidFast) and saves `public/updates.json`. Your static host redeploys on each save.

## Setup (about 10 minutes)
1. Create a free GitHub account and a **new repository** (private is fine).
2. Upload everything in this folder to it (keep the `.github` folder — on the GitHub web page use *Add file → Upload files*
   and drag the whole folder contents in; if `.github` is skipped, create `.github/workflows/update.yml` by hand and paste the file).
3. In the repo: **Settings → Actions → General → Workflow permissions → Read and write permissions → Save.**
4. Go to the **Actions** tab → *Update catalog* → **Run workflow**. After ~1 minute `public/updates.json` fills with titles.
5. Deploy the site from the repo:
   - **Netlify:** Add new site → Import from Git → pick the repo. (`netlify.toml` already sets the publish folder to `public`.)
   - or **Cloudflare Pages / GitHub Pages**, publish folder `public`.
6. Optional: add a free TMDB key as a repo secret named `TMDB_API_KEY` (Settings → Secrets and variables → Actions).

Netlify Drop (drag-and-drop) will NOT auto-update; it needs the Git connection in step 5.

## Notes
- The first run is a baseline; titles found after that are tagged NEW for 30 days.
- Change the schedule in `.github/workflows/update.yml` (`cron`). GitHub may delay scheduled runs by several minutes,
  and pauses them if the repo has no activity for 60 days (press *Run workflow* once to resume).
- `data/catalog.json` is the memory of what's been seen — don't delete it.
