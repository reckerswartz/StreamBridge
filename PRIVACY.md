# StreamBridge Privacy Policy

Effective: July 13, 2026

StreamBridge has no developer-operated server, account system, analytics, advertising, telemetry, or data sale. Its single purpose is to find media requests made by the page the user is viewing and offer local play, copy, and share controls.

## Data handled locally

StreamBridge observes media request URLs and limited response metadata, such as content type and content length. Exact URLs can contain browsing activity or temporary access tokens. They are kept only in tab-scoped memory and `storage.session`, with a maximum of 32 candidates per tab. State is removed on navigation, tab closure, explicit Clear, browser shutdown, or expiration. The extension is disabled in private browsing.

## Credential-free validation requests

To determine whether a detected URL is portable and playable, StreamBridge makes bounded requests to that same media origin or CDN. The requested URL and normal network connection information are therefore transmitted to that media provider. These requests deliberately omit cookies, authorization headers, browser credentials, and referrer information, use bounded byte ranges where possible, and stop after fixed time and size limits. StreamBridge does not send the URL to the extension developer or an analytics provider.

## User-requested actions

Copy URL writes the selected URL to the device clipboard. Share passes it to the browser or operating system share sheet only after the user selects Share; the user chooses any recipient application. Play in Browser opens the URL in a packaged extension player. StreamBridge does not automatically download media, launch a native application, bypass DRM, or replay private headers.

## Development diagnostics

Live-site and Android diagnostics are opt-in development tools. Reports sanitize query strings and URLs. Developers must not commit local site catalogs, cookies, tokens, captured response bodies, or device logs containing private information.

## Contact and changes

Security issues should be reported using the repository instructions at https://github.com/reckerswartz/StreamBridge/security. Material privacy changes will be documented in the changelog before a new version is released.
