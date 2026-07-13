---
title: Privacy Policy
---

# StreamBridge Privacy Policy

StreamBridge has no developer-operated server, account, advertising, analytics, or telemetry. It processes detected media URLs in tab-scoped session memory.

To validate portability, StreamBridge first makes bounded requests to the same media origin or CDN without cookies, authorization headers, browser credentials, or referrers. If that request is rejected, it may retry an exact URL already observed on the active page while retaining that page's normal Origin and Referer headers. Credentials remain omitted, and the result is labeled **Site-context**. StreamBridge does not transmit URLs to the developer.

The event-driven document-start observer retains a bounded set of HLS Resource Timing URLs and trusted pointer/media signals. It does not read page text or forms and does not poll or observe DOM mutations. Only after a trusted activation beside a visible landscape player may a generic bounded fallback inspect media/config-like global data properties for hidden HLS URLs. Getters are never invoked, no site list is used, and every result still requires manifest and media-segment validation.

Copy and Share send a selected URL to the clipboard or system share sheet only after a user action. The extension is disabled in private browsing and clears its session state on navigation, tab closure, browser shutdown, expiration, or Clear.

Sources labeled **Browser adapter** contain a structurally validated PNG envelope before MPEG-TS data. The packaged player fetches bounded fragments from the original CDN without credentials or referrers, removes the envelope in memory, and does not save or forward the media. Copy source URL warns that the manifest is not independently playable; VLC and Share are not offered for these entries.

Send to player shares the exact URL on Android or creates a temporary M3U locally. A portable desktop playlist contains the selected URL and browser user agent but no page referrer. A site-context playlist also contains the source origin; Firefox Android URL-safe encodes it into the optional bridge's explicit app link. The playlist never includes cookies or authorization headers. The optional VLC Bridge binds only to the device loopback address and streams the selected media from its original host to VLC without storing it or contacting a developer server.

The complete policy and change history are maintained in the [public repository](https://github.com/reckerswartz/StreamBridge/blob/main/PRIVACY.md).
