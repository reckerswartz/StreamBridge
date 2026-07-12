# StreamBridge

StreamBridge is a GPL-licensed Chrome and Firefox extension that detects HLS and direct-media requests after playback starts. It performs a bounded, credential-free portability check before placing a small control at the bottom of the page.

Verified streams can be played in an extension-hosted browser player, copied exactly, or passed to the platform Web Share menu. StreamBridge does not launch VLC directly, download media, bypass site protections, replay private headers, or collect browsing data.

## Development

Requirements: Node.js 24–26, npm, FFmpeg, Chrome/Chromium, and Firefox.

```bash
npm install
npm run verify
```

Useful commands:

```bash
npm run build          # dist/chrome and dist/firefox
npm run test:e2e       # deterministic Playwright extension checks
npm run lint:webext    # Mozilla extension validation
npm run package        # Chrome and Firefox ZIP packages
```

Load `dist/chrome` from `chrome://extensions` with Developer mode enabled. For Firefox, run:

```bash
npx web-ext run --source-dir dist/firefox
```

## Live-site diagnostics

Real or unstable URLs belong in the ignored `test/sites.local.json`, using the structure in `test/sites.example.json`. They never run in CI.

```bash
STREAMBRIDGE_LIVE_SITES=1 HEADED=1 npm run test:sites
```

Reports omit query strings, cookies, and authorization data.

## Stress and memory testing

The deterministic memory gate opens 15 extension-enabled tabs for three cycles, measures the extension worker heap separately from Chromium process memory, runs a 60-second playback burst, and verifies cleanup:

```bash
npm run stress:control
```

Public non-DRM samples and the ignored live-site catalog are report-only:

```bash
npm run stress:public
npm run stress:live
npm run stress:android
```

Use `STRESS_TABS`, `STRESS_CYCLES`, `STRESS_CAPTURE_SECONDS`, and `STRESS_BURST_SECONDS` to adjust a local campaign. Reports are sanitized and written beneath `.tmp/stress/`.

The Android runner uses bounded range requests to stress capture and cleanup without decoding 15 videos concurrently. Desktop Chromium owns the simultaneous-playback burst; Firefox Android suspends background media, and the project AVD has a known GPU decoder limitation.

## Architecture and limits

- Network classification is synchronous and bounded; validation runs with at most two concurrent jobs.
- Media probes omit credentials and referrers and stop after bounded byte limits.
- No permanent page content script or mutation observer is installed. The Shadow DOM UI is injected only after verification.
- Version 0.1 considers requests from the top document only, preventing unrelated advertising iframes from being presented as the page's stream.
- Completed HLS clips under ten seconds are ignored as promotional fragments; live playlists are not subject to this threshold.
- Each tab stores at most 32 candidates and is cleared on navigation or closure.
- The player loads `hls.js` only inside its own extension page. DASH is intentionally out of scope for version 0.1.

## License

Code and the original StreamBridge icon are licensed under GPL-3.0-only. No Freepik or reference-repository assets are included.
