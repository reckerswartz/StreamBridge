---
title: Privacy Policy
---

# StreamBridge Privacy Policy

StreamBridge has no developer-operated server, account, advertising, analytics, or telemetry. It processes detected media URLs in tab-scoped session memory.

To validate portability, StreamBridge first makes bounded requests to the same media origin or CDN without cookies, authorization headers, browser credentials, or referrers. If that request is rejected, it may retry an exact URL already observed on the active page while retaining that page's normal Origin and Referer headers. Credentials remain omitted, and the result is labeled **Site-context**. StreamBridge does not transmit URLs to the developer.

Copy and Share send a selected URL to the clipboard or system share sheet only after a user action. The extension is disabled in private browsing and clears its session state on navigation, tab closure, browser shutdown, expiration, or Clear.

Open in VLC creates a temporary M3U containing the selected stream URL, source origin, and browser user agent. Firefox Android URL-safe encodes it into the optional bridge's explicit app link; other platforms may share or download it locally. The playlist never includes cookies or authorization headers. The optional VLC Bridge binds only to the device loopback address and streams the selected media from its original host to VLC without storing it or contacting a developer server.

The complete policy and change history are maintained in the [public repository](https://github.com/reckerswartz/StreamBridge/blob/main/PRIVACY.md).
