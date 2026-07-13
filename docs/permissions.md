# Permission rationale

| Permission | Required behavior |
| --- | --- |
| `<all_urls>` | Run the bounded resource observer, observe media responses, and credential-free probe media URLs on arbitrary sites and user-activated embedded players, including bounded page-context retries for observed URLs. |
| `webRequest` | Detect HLS and direct-media response URLs and basic response metadata. |
| `scripting` | Check activation and visible playback in the request's own frame, inject the bottom control after validation, run a bounded MAIN-world validation retry, and inspect only data properties in a bounded generic HLS configuration fallback. |
| `storage` | Keep bounded, session-only stream and player handoff state. |
| `clipboardWrite` | Copy an exact URL only after the user selects Copy URL. |

`activeTab` and `tabs` are intentionally absent because required host access already authorizes script injection and access to the current tab URL. The extension uses only Tabs API operations that do not require the `tabs` permission. No permission is reserved for a future feature.

The document-start observer uses Resource Timing plus trusted pointer and media events. It has fixed URL/report/scan caps, does not read page text or form values, does not poll the DOM, and does not install a mutation observer. The MAIN-world configuration fallback runs only after a trusted activation beside a visible landscape video; it reads property descriptors without invoking getters and has fixed root, depth, object, URL-length, and result limits.

Send to player uses a user-triggered custom-scheme app link for site-context streams on Firefox Android, Android Web Share for portable streams, and a Blob download on desktop. It does not require `downloads`, `downloads.open`, native messaging, or control of installed applications. The optional Android VLC Bridge is packaged separately.
