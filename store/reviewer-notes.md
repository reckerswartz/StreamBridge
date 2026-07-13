# Reviewer test instructions

No account or credentials are required.

1. Install the submitted package and open the deterministic fixture with `npm run fixtures && npm run fixtures:serve`.
2. Visit `http://127.0.0.1:8765/fixture`.
3. Select **Play direct media**. The StreamBridge control appears at the bottom after validation.
4. Expand it and confirm **Play in Browser**, **Send to player**, **Copy URL**, and **Share** are present. On desktop, Send to player downloads an M3U for the selected portable stream.
5. Select **Detect HLS qualities** and confirm the control lists the 640×360 variant.
6. Open either result in the packaged player and confirm playback advances.
7. Navigate away and confirm the badge/session results clear.

For the deterministic site-context case, visit `http://127.0.0.1:8765/fixture/context`, select **Start referrer-dependent HLS**, and confirm the result is labeled **Site-context** with 360p, 480p, and 720p variants. On Android only, the user-triggered **Send to player** action opens the separately packaged GPL bridge through `streambridge-vlc://play`; the encoded M3U is not sent to a server. The optional APK is not part of either browser-store package and is not required to review the extension. Desktop/headless environments retain the local M3U fallback.

Validation requests are bounded and omit cookies, authorization, credentials, and referrers. The repository Playwright test automates the same flow.
