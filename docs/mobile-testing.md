# Firefox Android testing

Chrome for Android does not install Chrome Web Store extensions. StreamBridge mobile support targets Firefox for Android 142 or later.

For temporary development loading:

```bash
ADB_BIN="$HOME/Android/Sdk/platform-tools/adb" npm run stress:android
```

For a signed release, download the XPI in Firefox Android, open Settings > About Firefox, tap the Firefox logo five times, return to Settings, choose Install Extension from File, and select the XPI. Restart Firefox and confirm StreamBridge remains in the Extensions list.

The release gate uses an API-36 emulator, the declared minimum Firefox version, and a pinned current stable Firefox build. It validates installation persistence, responsive controls, playback, session cleanup, memory recovery, and sanitized `adb logcat` output.
