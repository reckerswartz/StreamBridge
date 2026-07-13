# StreamBridge Privacy Policy

Effective: July 13, 2026

StreamBridge has no developer-operated server, account system, analytics, advertising, telemetry, or data sale. Its single purpose is to find media requests made by the page the user is viewing and offer local play, copy, and share controls.

## Data handled locally

StreamBridge observes media request URLs and limited response metadata, such as content type and content length. Exact URLs can contain browsing activity or temporary access tokens. They are kept only in tab-scoped memory and `storage.session`, with a maximum of 32 candidates per tab. State is removed on navigation, tab closure, explicit Clear, browser shutdown, or expiration. The extension is disabled in private browsing.

## Credential-free validation requests

To determine whether a detected URL is portable and playable, StreamBridge first makes bounded requests to that same media origin or CDN without cookies, authorization headers, browser credentials, or referrer information. If that privacy-first request is rejected, StreamBridge may retry an exact URL already observed on the active page from that page's context. The fallback still omits cookies and credentials, but the browser may send the page's normal Origin and Referer headers. Such results are labeled **Site-context** because a copied URL may not work elsewhere. All probes use bounded byte ranges where possible and stop after fixed time and size limits. StreamBridge does not send the URL to the extension developer or an analytics provider.

A small document-start observer keeps a bounded set of HLS Resource Timing URLs and listens for trusted pointer/media events. It does not read page text, form values, or browsing history, does not poll the DOM, and does not use a mutation observer. After a trusted activation next to a visible landscape video, StreamBridge may inspect a bounded graph of data properties under media/config-like global names to find HLS URLs hidden inside a page player configuration. It never invokes getters, contains no per-site rules, and still validates a manifest and media segment before showing a result.

## User-requested actions

Copy URL writes the selected URL to the device clipboard. Share passes it to the browser or operating system share sheet only after the user selects Share; the user chooses any recipient application. Play in Browser opens the URL in a packaged extension player.

Some providers place MPEG-TS data after a small PNG envelope. When StreamBridge identifies that structure, its packaged player fetches each selected media fragment directly from the original CDN without credentials or referrer data, keeps no more than 16 MiB for the active fragment, removes only the validated envelope and bounded padding in memory, and gives the MPEG-TS bytes to the bundled player. The media is not saved or sent elsewhere. These entries are labeled **Browser adapter**; copy is offered as **Copy source URL** with a warning that the manifest is not independently playable, and VLC/Share actions are withheld.

Send to player acts only after a user action. For a portable stream, Android receives the exact URL through its share sheet and desktop receives a small M3U containing the URL and current browser user agent without page context. For a site-context stream, the M3U also contains the source page origin as an HTTP referrer. It does not contain cookies, authorization headers, page content, or unrelated browsing history. Firefox Android URL-safe encodes a site-context playlist into the optional bridge's explicit app link; desktop downloads the M3U locally.

The separately installed, optional StreamBridge VLC Bridge reads a site-context M3U only after the user taps Send to player. On Firefox Android the M3U is URL-safe encoded into the bridge's local custom-scheme intent; it is not sent to a web server. The bridge binds a tokenized HTTP endpoint exclusively to the device loopback address, requests the selected manifests and media directly from their original hosts with the M3U's referrer and user agent, and streams the response to VLC without saving the media. It has no developer-operated endpoint, cookies, authorization data, analytics, or telemetry. Its foreground notification provides a Stop action. Neither component bypasses DRM or authenticated access controls.

## Development diagnostics

Live-site and Android diagnostics are opt-in development tools. Reports retain only sanitized host/path locations and omit query strings, cookies, page titles, and authorization data. Developers must not commit local site catalogs, cookies, tokens, captured response bodies, or device logs containing private information.

## Contact and changes

Security issues should be reported using the repository instructions at https://github.com/reckerswartz/StreamBridge/security. Material privacy changes will be documented in the changelog before a new version is released.
