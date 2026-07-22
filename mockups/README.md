# Mockups

Static, self-contained HTML mockups for the Staffility Integrator admin.
Not part of the app build — deployed as its own Netlify static site.

- `index.html` — the AI-Agents registry admin mockup (AI Agents + Aggregators
  screens). Clickable; edits are in-page only.

## Deploy
This folder is published as-is (no build). To update the live mock: edit
`index.html`, commit, and push — Netlify redeploys from `main`.
Netlify build settings: Build command = (empty), Publish directory = `mockups`.
