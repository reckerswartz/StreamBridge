# Reviewer test instructions

No account or credentials are required.

1. Install the submitted package and open the deterministic fixture with `npm run fixtures && npm run fixtures:serve`.
2. Visit `http://127.0.0.1:8765/fixture`.
3. Select **Play direct media**. The StreamBridge control appears at the bottom after validation.
4. Expand it and confirm **Play in Browser**, **Copy URL**, and **Share** are present.
5. Select **Detect HLS qualities** and confirm the control lists the 640×360 variant.
6. Open either result in the packaged player and confirm playback advances.
7. Navigate away and confirm the badge/session results clear.

Validation requests are bounded and omit cookies, authorization, credentials, and referrers. The repository Playwright test automates the same flow.
