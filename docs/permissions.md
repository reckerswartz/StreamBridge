# Permission rationale

| Permission | Required behavior |
| --- | --- |
| `<all_urls>` | Observe and credential-free probe media URLs on arbitrary sites. |
| `webRequest` | Detect HLS and direct-media response URLs and basic response metadata. |
| `tabs` | Associate a response with its top document, clear state on navigation/closure, and open the packaged player. |
| `scripting` | Inject the bottom control only after at least one candidate passes validation. |
| `storage` | Keep bounded, session-only stream and player handoff state. |
| `clipboardWrite` | Copy an exact URL only after the user selects Copy URL. |

`activeTab` is intentionally absent because required host access already authorizes script injection. No permission is reserved for a future feature.
