# Bark Monitor

- `index.html` — the Listener page, served by GitHub Pages.
- `apps-script/` — the Google Apps Script back end, dashboard and PDF report.
  Changes pushed to `main` deploy automatically through `.github/workflows/deploy-apps-script.yml`
  (updates the existing web app deployment, so the URL never changes).

No keys or data live in this repository. The secret key is stored in the Apps Script project's
properties, and the deploy credentials are encrypted GitHub Actions secrets.
