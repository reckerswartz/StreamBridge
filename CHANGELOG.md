# Changelog

All notable StreamBridge changes are documented here. Releases follow semantic versioning.

## [Unreleased]

## [0.1.1] - 2026-07-13

### Added

- Added a bounded, credential-free page-context fallback for media origins that reject no-referrer validation requests.
- Added explicit Portable and Site-context labels, external-player warnings, and a Resume site player action.
- Added deterministic Playwright coverage for referrer-dependent HLS, multiple qualities, and MPEG-TS segments served with misleading image content types.
- Added a user-triggered VLC handoff that shares a sanitized, header-aware M3U for site-context streams and downloads it when file sharing is unavailable.
- Added an optional 21 KiB Android VLC Bridge that preserves per-stream M3U referrer headers over a tokenized, loopback-only HLS proxy and launches official VLC without a per-site global setting.

### Changed

- Nested HLS media playlists are hidden when their verified master playlist already exposes them as quality variants.
- Page-context validation retains the active page's browser-generated Origin and Referer headers while continuing to omit cookies and credentials.
- VLC playlists contain only the selected URL, source origin, and browser user agent; no cookie or authorization data is forwarded.
- Documented and physically verified that official VLC Android 3.7.x discards per-item playlist headers; site-context Android playback now directs users to VLC Bridge instead of claiming direct VLC support.

## [0.1.0] - 2026-07-13

### Added

- Cross-browser Manifest V3 builds for Chrome and Firefox.
- Automatic, bounded detection of HLS and direct-media requests from the top-level page.
- Credential-free stream validation, HLS quality discovery, exact URL copying, platform sharing, and browser playback.
- Responsive bottom-of-page controls, session-only state, and bounded per-tab queues.
- Deterministic Playwright coverage plus 15-tab desktop and Firefox Android memory diagnostics.
- Reproducible release packages, checksums, SPDX SBOM, reviewer source, store assets, and GitHub artifact provenance.
- Protected Mozilla Add-ons and Chrome Web Store submission workflows.
- Firefox Android smoke coverage at the declared minimum and a pinned stable browser version, with bounded emulator boot diagnostics.

### Changed

- Replaced SVG manifest icons with Chrome-compatible PNG sizes while retaining the original GPL SVG source.
- Removed the redundant `activeTab` permission and documented every remaining permission.
- Declared required Firefox browsing-activity transmission because validation re-requests the detected URL from its media origin.

### Security

- Disabled private-browsing operation and continued to omit cookies, authorization headers, credentials, and referrer data from validation probes.
- Kept live-site URLs, captured tokens, response bodies, and device logs out of release packages.

[Unreleased]: https://github.com/reckerswartz/StreamBridge/compare/v0.1.0...HEAD
[0.1.1]: https://github.com/reckerswartz/StreamBridge/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/reckerswartz/StreamBridge/releases/tag/v0.1.0
