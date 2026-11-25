# Bark Monitor

- `index.html` — the Listener page, served by GitHub Pages (and by Cloudflare at `/listener`).
- `apps-script/` — the Google Apps Script back end, dashboard and PDF report.
  Changes pushed to `main` deploy automatically through `.github/workflows/deploy-apps-script.yml`
  (updates the existing web app deployment, so the URL never changes).
- `src/worker.js`, `cf/app.html`, `wrangler.jsonc` — the Cloudflare demo (demo2) for testers:
  sign-in, per-user logs in D1, clips in R2, feedback, and a two-way sync with the Google Sheet and
  Drive every 5 minutes. Deployed by Cloudflare Workers Builds on every push to `main`.
  Needs two Worker secrets: `APPS_SCRIPT_URL` and `APPS_SCRIPT_KEY`.

No keys or data live in this repository. The secret key is stored in the Apps Script project's
properties, the Cloudflare secrets in the Worker settings, and the deploy credentials are encrypted
GitHub Actions secrets.
