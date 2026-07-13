# Firefox Android testing

Chrome for Android does not install Chrome Web Store extensions. StreamBridge mobile support targets Firefox for Android 142 or later.

For temporary development loading:

```bash
ADB_BIN="$HOME/Android/Sdk/platform-tools/adb" npm run stress:android
```

The runner boots the configured `tnfr_uat_api36` AVD when no emulator is attached, completes Firefox onboarding, enables and verifies Remote debugging via USB, installs the unpacked extension temporarily with `web-ext`, opens deterministic fixture tabs through Firefox Remote Debugging Protocol, checks capture/session cleanup and memory recovery, writes sanitized reports under `.tmp/stress/`, and shuts down only the emulator it started. Set `ANDROID_AVD`, `ADB_BIN`, or `FIREFOX_PACKAGE` to override local defaults.

Run `npm run test:e2e` and `npm run stress:control` before the emulator pass. The browser adapter is validated in Chromium first because Firefox Android may suspend background media and emulator GPU decoding is not a reliable substitute for URL and extension-lifecycle verification.

For an opt-in live Firefox-to-VLC gate, add one `livePlayback` entry to ignored `test/sites.local.json`, build the browser proof first, and then run:

```bash
STREAMBRIDGE_LIVE_SITES=1 npm run test:live-playback
STREAMBRIDGE_LIVE_SITES=1 npm run test:android-live
```

The Android live runner uses `ANDROID_AVD` (default `tnfr_uat_api36`), `ADB_DEVICE` (default `emulator-5554`), and the Firefox APK at `FIREFOX_ANDROID_APK` (default `.tmp/android/firefox-152.0.5-x86_64.apk`). It downloads pinned official VLC 3.7.0 only after verifying VideoLAN's SHA-256, builds and installs the debug VLC Bridge, temporary-loads the extension, and performs real ADB taps. Set `KEEP_ANDROID_EMULATOR=1` during debugging to retain an emulator started by the runner.

The pass condition is stricter than an intent check: every configured quality must be visible in Firefox, VLC must publish `PLAYING(3)`, and either VLC's reported position or its successful proxied HLS response count must advance. A site player that exposes `NETWORK_NO_SOURCE` on the emulator is recorded as `sourcePlayback: false`; it does not fail the gate when the user-activated HLS manifests and first segments validate and VLC actually plays them. Sanitized reports and filtered logs are written beneath `.tmp/live-android/`.

For a signed release, download the XPI in Firefox Android, open Settings > About Firefox, tap the Firefox logo five times, return to Settings, choose Install Extension from File, and select the XPI. Restart Firefox and confirm StreamBridge remains in the Extensions list.

The release gate uses an API-36 emulator, the declared minimum Firefox version, and a pinned current stable Firefox build. It validates installation persistence, responsive controls, playback, session cleanup, memory recovery, and sanitized `adb logcat` output. The opt-in live runner is a local diagnostic and is not run in CI because live pages and signed media URLs are unstable and must not enter repository fixtures.

For site-context VLC playback, also install the signed `streambridge-*-vlc-bridge.apk` from the same GitHub Release and VLC for Android. Start the website player, open StreamBridge, and tap **Send to player**. Firefox should hand the encoded M3U to the bridge, and the bridge should open official VLC without a per-site VLC setting. Use the bridge notification's Stop action after playback. Portable streams use Android's normal share sheet instead.
