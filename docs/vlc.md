# VLC handoff

StreamBridge does not control native applications silently. **Send to player** is always initiated by a user click. Portable streams use Android's share sheet or a context-free desktop M3U download. Site-context streams use a header-aware M3U; Firefox Android opens the optional bridge handler, while desktop downloads the playlist for a compatible player.

Portable streams are shared as their exact URL and can normally be sent straight to VLC. Site-context streams are shared as a temporary `.m3u` file with `http-referrer` and `http-user-agent` options. The file contains no cookie or authorization value.

## Android VLC Bridge

VLC for Android 3.7.1 and the current 3.7.2 beta discard per-item options while converting a parsed playlist entry into their internal playback queue. M3U option ordering, XSPF options, `#EXTHTTP`, pipe-style headers, local files, remote files, and video/audio MIME launch routes were all verified on a physical Android 16 device; the media requests still had an empty `Referer`.

Install the optional `streambridge-*-vlc-bridge.apk`. On Firefox Android, **Send to player** for a site-context stream opens the bridge's narrow `streambridge-vlc://play` handler directly from that user click; the encoded M3U remains on the device. The bridge:

1. reads the exact stream URL, referrer, and user agent from the shared M3U;
2. binds an HTTP server to `127.0.0.1` on a random port with a random 192-bit session token;
3. fetches HLS manifests and segments directly from their original hosts with those credential-free headers;
4. rewrites HLS child URLs to the same tokenized loopback session; and
5. launches the installed official VLC app with the loopback URL.

The bridge has no Internet-facing listener, developer server, analytics, cookies, or media storage. It caps a manifest at 2 MiB, streams media in 64 KiB chunks with six workers, and exposes a Stop action in its foreground notification. Stop the bridge after playback.

The action is also available for each detected HLS quality. If a master playlist is incompatible with a player, select a specific quality and try its Send to player action.

If the bridge is not installed, Firefox reports that no application handles the link. Install the APK and tap again. The normal M3U share/download fallback remains available on other platforms; desktop users can open that file with VLC. The extension itself never downloads the media.

Some providers may still require cookies, DRM, authorization, or browser-specific TLS behavior. The bridge intentionally does not forward or reproduce those. StreamBridge retains **Resume site player** as the reliable fallback and does not bypass access controls.
