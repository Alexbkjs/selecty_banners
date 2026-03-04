# Selecty — Banner Manager for Shopify

A Chrome extension that exports and imports [Selecty](https://selectors.devit.software) banner configurations across Shopify stores.

## Demo

https://github.com/user-attachments/assets/05.03.2026_00.19.18_REC.mp4

<video src="05.03.2026_00.19.18_REC.mp4" controls width="100%"></video>

## Features

- **Export banners** — Capture banner design + i18n data from any Shopify storefront or admin panel
- **Import banners** — Apply a saved banner configuration to any connected store
- **Banner library** — All banners stored in Supabase with live preview thumbnails
- **Custom preview images** — Replace auto-generated thumbnails with your own screenshots (camera icon on hover)
- **Clickable store links** — Banner names link directly to the store's Selecty preview (`/?selectors_preview`)
- **Dark / Light theme** — Toggle with the moon/sun button, persisted across sessions
- **Background switcher** — Choose from preset background images or use a plain background
- **Auto-connect** — Automatically captures session tokens when you browse Shopify admin

## How It Works

1. **Open Shopify admin** — The extension hooks `fetch` requests to capture CSRF tokens and session details
2. **Export** — Reads banner data from `window.__selectors.autodetect` (storefront) or fetches it via the Selecty API (admin)
3. **Import** — Merges saved design/i18n data into the target store's existing element data via the Selecty API
4. **Storage** — All banner data is persisted in a Supabase `banners` table

## Project Structure

```
├── manifest.json        # Chrome MV3 extension manifest
├── background.js        # Service worker — opens side panel, persists session data
├── inject.js            # MAIN world script — hooks fetch to capture tokens
├── content.js           # ISOLATED world script — bridges page messages to extension
├── sidepanel.html       # Side panel UI
├── sidepanel.js         # Side panel logic — export, import, rendering, Supabase client
├── sidepanel.css        # Styles with light/dark theme variables
├── supabase.min.js      # Supabase JS client (bundled)
├── icons/               # Extension icons (16, 32, 48, 128)
└── backgrounds/         # Background images for the panel
```

## Installation

1. Clone this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode**
4. Click **Load unpacked** and select the project folder
5. Navigate to any Shopify admin page — the extension auto-captures session tokens
6. Click the Selecty icon in the toolbar to open the side panel

## Database Setup

The extension uses Supabase. The `banners` table schema:

```sql
CREATE TABLE banners (
  id TEXT PRIMARY KEY,
  name TEXT,
  exported_at TIMESTAMPTZ,
  source_url TEXT,
  design JSONB,
  i18n JSONB,
  preview_url TEXT
);
```

## Usage

| Action | How |
|---|---|
| **Export** | Navigate to a storefront with Selecty installed or Shopify admin, click **Export** |
| **Import** | Select a banner from the library, click **Import** (must be on Shopify admin) |
| **Custom preview** | Hover a banner thumbnail, click the camera icon, select an image |
| **Preview store** | Click the banner name to open the store with `/?selectors_preview` |
| **Delete** | Click the **x** button on any banner card |
