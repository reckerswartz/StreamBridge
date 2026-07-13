# Store submission guide

## Single purpose

StreamBridge finds media requests made by the active page or a user-activated embedded player and verifies them without private credentials. Portable URLs can use the built-in player; URLs that retain the source page's normal Origin or Referer are labeled site-context before copy or share actions are offered. Normal embedded requests require an activated, advancing, visible landscape video in their own frame. A bounded page-configured HLS fallback instead requires real activation, a visible landscape player, and successful manifest plus first-segment validation, allowing capture when the site's Firefox player itself cannot decode the source. Unrelated autoplay and portrait advertising frames remain excluded.

The packaged player includes a bounded fragment adapter for a content-defined format: a complete PNG envelope, optional bounded zero/`0xff` padding, and repeated MPEG-TS packet boundaries. It is not tied to a website hostname, does not bypass DRM or access controls, loads no remote code, and withholds VLC/Share because the raw manifest is not independently playable.

The user-triggered Send to player action opens Android sharing for portable streams or downloads a context-free M3U on desktop. For a site-context stream it creates a local M3U containing the selected URL, source origin, and browser user agent; Firefox Android URL-safe encodes that playlist into the optional bridge's explicit custom-scheme link. This requires no new extension permission. The GPL Android VLC Bridge is a separate application and is not bundled into either browser-store archive; its loopback behavior is disclosed in the privacy policy and player-handoff documentation.

## Review disclosures

- Broad host and `webRequest` access are required because automatic detection must observe a media response when playback begins, before the user could grant a per-site permission.
- A document-start content script is included because worker-created HLS requests are not consistently visible to `webRequest`. It observes only Resource Timing and trusted pointer/media events with fixed caps and no DOM polling. After activation, the generic fallback examines bounded media/config-like data properties without invoking getters; it contains no website list or remotely supplied logic.
- Validation re-requests the detected URL from its media origin. Firefox declares required `browsingActivity`; Chrome disclosures state that browsing activity and website resources are processed locally and sent only to the selected media provider for validation.
- No remote executable code is loaded. `hls.js` and the WebExtension polyfill are bundled in the package.
- No analytics, advertising, account data, cookies, authorization headers, or developer server are used.
- Private browsing is disabled.

Use the deterministic fixture described in `store/reviewer-notes.md`; do not use adult, paid, authenticated, or unstable websites in listing screenshots or reviewer instructions.

## One-time dashboard setup

- Mozilla: create AMO API credentials, configure `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` in the protected GitHub environment, and set repository variable `AMO_AUTOMATION_ENABLED=true` only when automated listed submission is intended.
- Chrome: register the developer account, enable two-step verification, create the first item, complete Store Listing and Privacy tabs, enable Chrome Web Store API v2, and add the service account to the publisher account.
- GitHub: protect the store environments with required reviewers and enable Pages from GitHub Actions. Chrome submission remains disabled unless `CWS_AUTOMATION_ENABLED=true` is set explicitly.
