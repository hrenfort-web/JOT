# Jot — App Assets

The PNGs in this folder are placeholders from Expo's project template. The
production icon and splash designs live as SVG sources here:

- `icon-source.svg` — square 1024×1024 app icon (green field, white checkmark
  with a small notebook-corner accent).
- `splash-source.svg` — splash screen with the Jot wordmark.

## Generating the PNG assets

Expo expects PNGs at these paths (referenced from `app.json`):

| File                 | Size       | Purpose                                       |
| -------------------- | ---------- | --------------------------------------------- |
| `icon.png`           | 1024×1024  | iOS app icon, expo-notifications small icon  |
| `adaptive-icon.png`  | 1024×1024  | Android adaptive foreground (safe zone 432px) |
| `splash-icon.png`    | 1242×2688  | Launch screen image                          |
| `favicon.png`        | 48×48      | Web favicon                                  |

Export options (any vector tool — Figma, Affinity, Inkscape, or `rsvg-convert`):

```bash
# Using rsvg-convert (brew install librsvg)
rsvg-convert -w 1024 -h 1024 icon-source.svg -o icon.png
rsvg-convert -w 1024 -h 1024 icon-source.svg -o adaptive-icon.png
rsvg-convert -w 1242 -h 2688 splash-source.svg -o splash-icon.png
rsvg-convert -w 48 -h 48 icon-source.svg -o favicon.png
```

After regenerating, run `npx expo prebuild --clean` so the native projects pick
up the new icons.
