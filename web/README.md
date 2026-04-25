# Lele Investor Swipe

Tinder-style triage UI for cutting the SF investor list down to ~5× meetings target.

## Run locally
```bash
cd web
npm install
npm run dev
# open http://localhost:3000
```

## Deploy to Vercel (~2 min)

1. Go to <https://vercel.com/new>
2. Import the GitHub repo `jxutaposition/991`
3. **Root Directory**: set to `web`
4. Framework preset: **Next.js** (auto-detected)
5. Click **Deploy**

Vercel returns a public URL when build finishes. Bookmark on your phone.

## Data
- `lib/investors.json` — 377 SF profiles (warm + cold angels + cold partners)
- Decisions stored in browser `localStorage` only (no server)
- Export CSV button downloads your kept/cut list

## Keyboard
- `←` cut · `→` keep · `↑` back

## Re-running enrichment
The enrichment data is baked into `lib/investors.json` at build time. To refresh, regenerate from the CSVs in `/data/` and replace `lib/investors.json`, then redeploy (Vercel auto-rebuilds on push).
