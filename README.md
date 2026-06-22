# Free AI Image Upscaler — frontend

The centered design from the Floyo handoff, implemented for real. Pixel-identical
to the prototype; the only change is that **real uploads now call your Flask
backend** instead of faking the upscale.

```
index.html            the page (renamed from "Free AI Image Upscaler.html")
upscaler.js           UI state machine + backend wiring
colors_and_type.css   Floyo design tokens (Roboto now via Google Fonts)
fonts/                Janeiro.otf, ArcadePixelNeue.otf  (display + pixel)
assets/icons/         the 14 pixel icons the page uses
```

## 1. Point it at your backend
One line, top of `upscaler.js`:
```js
var API_BASE = "";   // "" = same origin; else "https://api.yourdomain.com"
```
Must be **HTTPS** if the page is served over HTTPS (no mixed content).

## 2. What it sends
On "Upscale image" with a real uploaded file, it `POST`s multipart to
`/api/upscale`:

| field | value | from |
|-------|-------|------|
| `file` | the image | upload |
| `upscale_factor` | `2` or `4` | segmented control |
| `sharpness` | `soft`/`normal`/`sharp`/`very_sharp` | detail slider |
| `color_correction` | `true`/`false` | toggle |
| `seed` | int (only if "Lock seed" is on) | seed field |
| `target` | `2k`/`4k`/`8k` | informational |
| `format` | `jpg`/`png`/`webp` | informational |

These names match the backend's `parse_settings`. It then polls
`/api/jobs/<id>` (queued → uploading → running → done|failed) and, on done,
shows `/api/jobs/<id>/files/<fid>` as the "after" image and downloads from there.

## 3. Run / deploy
Static files — host anywhere. Local check:
```bash
cd upscaler-frontend && python3 -m http.server 8080   # http://localhost:8080
```
Vercel: framework preset **Other**, deploy the folder as-is. Keep frontend and
backend both HTTPS.

## Notes / honest caveats
- **"Try a sample" and "add a URL" stay offline** (local mock animation) so demo
  clicks don't burn GPU credits. Only real file uploads hit the backend. To make
  URLs real: fetch the URL → Blob → wrap in a File → `handleFile()`.
- **`target` (2K/4K/8K) and `format` are sent but the backend currently ignores
  them.** The real output lever is `upscale_factor`; the backend always returns
  **PNG**. The dropdown still drives the on-screen size estimate. Wire `target`
  to the SeedVR2 `resolution`, and add a format-capable save node, when ready.
- **Limits mirror the backend**: ≤25 MB and ≤~6 MP client-side, so oversized
  files are rejected before upload.
- Progress % is animated (the backend reports status text, not a percentage):
  the bar eases toward ~90% while the GPU works, then jumps to 100% on done.
  Status text under the bar comes straight from the backend `message`.
- Roboto loads from Google Fonts (the original bundle's Roboto files were empty);
  Janeiro and Arcade Pixel are self-hosted. To self-host Roboto instead, drop real
  variable `.ttf`s into `fonts/` and restore the `@font-face` blocks noted in the CSS.
