# Release runbook

1. Update `CHANGELOG.md` and set the same numeric version in `package.json` and `package-lock.json`.
2. Configure the repository secrets `ANDROID_BRIDGE_KEYSTORE_BASE64`, `ANDROID_BRIDGE_KEY_ALIAS`, `ANDROID_BRIDGE_KEYSTORE_PASSWORD`, and `ANDROID_BRIDGE_KEY_PASSWORD`. Keep an offline backup of the same Android signing key; future bridge APKs must use it to update an installed copy.
3. Run `npm run verify`, `npm run android:bridge`, and `npm run release:reproducible`. The local bridge command produces a debug-signed APK for testing only.
4. Commit and push the release changes, then create and push the matching annotated tag, such as `v0.1.0`.
5. The release workflow creates a draft GitHub Release and attaches checksummed, attested extension packages plus the release-signed VLC Bridge APK.
6. Approve the protected Mozilla and Chrome submission environments after inspecting the draft assets.
7. After Mozilla marks the listed version public, run the Store Finalize workflow. It downloads the signed XPI, runs persistent desktop and Android installation checks, attaches the XPI, and publishes the GitHub Release.

The Chrome ZIP attached to GitHub is for store upload or developer-mode testing. Normal Chrome users install from the Chrome Web Store. Firefox users may install the Mozilla-signed XPI from GitHub or AMO. Android users install the separately signed VLC Bridge APK only when they need site-context playback in official VLC.
