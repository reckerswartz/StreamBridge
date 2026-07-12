# Reviewer build instructions

The submitted extension uses esbuild to bundle readable, non-minified JavaScript. This source archive contains everything needed to reproduce both store ZIPs.

Environment:

- Ubuntu 24.04 or a compatible Linux distribution
- Node.js 24.x
- npm 11.x
- `zip`, FFmpeg, ImageMagick, Chromium, and Firefox

Build from the archive root:

```bash
npm ci
npm run release:check
npm run package
```

The Chrome and Firefox store packages are written to `artifacts/`. Dependencies are fetched only from the official npm registry and are pinned by `package-lock.json`. No commercial or web-based build tools are used.

To run all automated checks, install Playwright Chromium and use:

```bash
npx playwright install --with-deps chromium
npm run verify
```
