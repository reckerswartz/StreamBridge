# Store submission guide

## Single purpose

StreamBridge finds media requests made by the active top-level page and verifies them without private credentials. Portable URLs can use the built-in player; URLs that retain the source page's normal Origin or Referer are labeled site-context before copy or share actions are offered.

The user-triggered Open in VLC action creates a small local M3U wrapper containing the selected URL, source origin, and browser user agent. On Android it is URL-safe encoded into the optional bridge's explicit custom-scheme link; on other platforms it uses share/download behavior. This requires no new extension permission. The GPL Android VLC Bridge is a separate application and is not bundled into either browser-store archive; its loopback behavior is disclosed in the privacy policy and VLC documentation.

## Review disclosures

- Broad host and `webRequest` access are required because automatic detection must observe a media response when playback begins, before the user could grant a per-site permission.
- Validation re-requests the detected URL from its media origin. Firefox declares required `browsingActivity`; Chrome disclosures state that browsing activity and website resources are processed locally and sent only to the selected media provider for validation.
- No remote executable code is loaded. `hls.js` and the WebExtension polyfill are bundled in the package.
- No analytics, advertising, account data, cookies, authorization headers, or developer server are used.
- Private browsing is disabled.

Use the deterministic fixture described in `store/reviewer-notes.md`; do not use adult, paid, authenticated, or unstable websites in listing screenshots or reviewer instructions.

## One-time dashboard setup

- Mozilla: create AMO API credentials and configure `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` in the protected GitHub environment.
- Chrome: register the developer account, enable two-step verification, create the first item, complete Store Listing and Privacy tabs, enable Chrome Web Store API v2, and add the service account to the publisher account.
- GitHub: protect the store environments with required reviewers and enable Pages from GitHub Actions.
