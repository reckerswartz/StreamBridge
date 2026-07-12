# Changelog

All notable StreamBridge changes are documented here. Releases follow semantic versioning.

## [Unreleased]

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
[0.1.0]: https://github.com/reckerswartz/StreamBridge/releases/tag/v0.1.0
