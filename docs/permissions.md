# Permission rationale

| Permission | Required behavior |
| --- | --- |
| `<all_urls>` | Observe and credential-free probe media URLs on arbitrary sites, including bounded page-context retries for observed URLs. |
| `webRequest` | Detect HLS and direct-media response URLs and basic response metadata. |
| `tabs` | Associate a response with its top document, clear state on navigation/closure, and open the packaged player. |
| `scripting` | Inject the bottom control after validation and run a bounded MAIN-world fallback when a no-referrer probe is rejected. |
| `storage` | Keep bounded, session-only stream and player handoff state. |
| `clipboardWrite` | Copy an exact URL only after the user selects Copy URL. |

`activeTab` is intentionally absent because required host access already authorizes script injection. No permission is reserved for a future feature.

Open in VLC uses a user-triggered custom-scheme app link on Firefox Android and standard Web Share or Blob download APIs elsewhere. It does not require `downloads`, `downloads.open`, native messaging, or control of installed applications. The optional Android VLC Bridge is packaged separately.
