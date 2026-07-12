# Security

Report security issues privately to the repository owner rather than opening a public issue.

StreamBridge accepts only HTTP and HTTPS media URLs, bounds all parsing and probes, omits browser credentials during validation, and enables playback or sharing only for recently verified candidates. It does not attempt DRM circumvention, challenge bypasses, private-header replay, or cross-origin policy workarounds.

Never place GitHub tokens, cookies, signed media URLs, or authorization headers in issues, commits, fixtures, screenshots, or test logs.
