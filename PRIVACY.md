# Privacy

StreamBridge processes detected media URLs locally in the browser. It does not operate a server, transmit browsing history, use analytics, or sell data.

Validation requests deliberately omit cookies, authorization headers, browser credentials, and referrer information. Exact URLs remain in tab-local memory so the user can copy, share, or play them. State is cleared when the page navigates, the tab closes, or the user selects Clear.

Live-site development logs are opt-in and sanitize query strings. Developers must not commit `test/sites.local.json`, cookies, tokens, captured response bodies, or Android logs containing private data.
