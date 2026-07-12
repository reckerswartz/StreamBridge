package com.streambridge.bridge;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ResultReceiver;
import android.view.Gravity;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

public final class MainActivity extends Activity {
    private static final int MAX_PLAYLIST_BYTES = 1_048_576;
    private TextView status;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        status = new TextView(this);
        status.setGravity(Gravity.CENTER);
        status.setPadding(48, 48, 48, 48);
        status.setText("Opening StreamBridge playlist…");
        setContentView(status);
        new Thread(() -> handle(getIntent()), "streambridge-import").start();
    }

    private void handle(Intent intent) {
        try {
            String playlist = readPlaylist(intent);
            PlaylistEntry entry = PlaylistEntry.parse(playlist);
            runOnUiThread(() -> startBridge(entry));
        } catch (Exception error) {
            showError(error.getMessage() == null ? "Could not read this playlist." : error.getMessage());
        }
    }

    private String readPlaylist(Intent intent) throws Exception {
        Uri uri = null;
        if (Intent.ACTION_VIEW.equals(intent.getAction()) && "streambridge-vlc".equals(intent.getData() == null ? null : intent.getData().getScheme())) {
            String encoded = intent.getData().getQueryParameter("m3u");
            if (encoded == null) throw new IllegalArgumentException("The StreamBridge link contains no playlist.");
            byte[] decoded = Base64.getUrlDecoder().decode(encoded);
            if (decoded.length > MAX_PLAYLIST_BYTES) throw new IllegalArgumentException("The playlist is larger than 1 MiB.");
            return new String(decoded, StandardCharsets.UTF_8);
        }
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            ClipData clip = intent.getClipData();
            if (clip != null && clip.getItemCount() > 0) uri = clip.getItemAt(0).getUri();
            if (uri == null && Build.VERSION.SDK_INT >= 33) uri = intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
            if (uri == null) uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            if (uri == null && text != null) {
                String value = text.toString();
                if (value.startsWith("#EXTM3U")) return value;
                uri = Uri.parse(value);
            }
        } else {
            uri = intent.getData();
        }
        if (uri == null) throw new IllegalArgumentException("Share a StreamBridge .m3u playlist with this app.");
        try (InputStream input = open(uri)) {
            return new String(readBounded(input, MAX_PLAYLIST_BYTES), StandardCharsets.UTF_8);
        }
    }

    private InputStream open(Uri uri) throws Exception {
        String scheme = uri.getScheme();
        if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) {
            HttpURLConnection connection = (HttpURLConnection) new URL(uri.toString()).openConnection();
            connection.setConnectTimeout(10_000);
            connection.setReadTimeout(15_000);
            return connection.getInputStream();
        }
        InputStream input = getContentResolver().openInputStream(uri);
        if (input == null) throw new IllegalArgumentException("The shared playlist could not be opened.");
        return input;
    }

    private static byte[] readBounded(InputStream input, int maximum) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[16_384];
        int total = 0;
        for (int count; (count = input.read(buffer)) != -1;) {
            total += count;
            if (total > maximum) throw new IllegalArgumentException("The playlist is larger than 1 MiB.");
            output.write(buffer, 0, count);
        }
        return output.toByteArray();
    }

    private void startBridge(PlaylistEntry entry) {
        status.setText("Starting the private loopback bridge…");
        Intent service = new Intent(this, BridgeService.class)
            .putExtra(BridgeService.EXTRA_URL, entry.url)
            .putExtra(BridgeService.EXTRA_REFERRER, entry.referrer)
            .putExtra(BridgeService.EXTRA_USER_AGENT, entry.userAgent)
            .putExtra(BridgeService.EXTRA_RECEIVER, new ResultReceiver(new Handler(Looper.getMainLooper())) {
                @Override protected void onReceiveResult(int code, Bundle data) {
                    if (code != BridgeService.RESULT_READY) {
                        showError(data == null ? "The bridge could not start." : data.getString(BridgeService.EXTRA_ERROR, "The bridge could not start."));
                        return;
                    }
                    launchVlc(data.getString(BridgeService.EXTRA_LOCAL_URL));
                }
            });
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(service); else startService(service);
    }

    private void launchVlc(String url) {
        if (url == null) { showError("The bridge returned no playback URL."); return; }
        Intent vlc = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        vlc.setPackage("org.videolan.vlc");
        vlc.setDataAndType(Uri.parse(url), "application/vnd.apple.mpegurl");
        vlc.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            startActivity(vlc);
            finish();
        } catch (Exception error) {
            showError("Install VLC for Android, then share the playlist again.");
        }
    }

    private void showError(String message) {
        runOnUiThread(() -> {
            status.setText(message);
            Toast.makeText(this, message, Toast.LENGTH_LONG).show();
        });
    }

    static final class PlaylistEntry {
        final String url;
        final String referrer;
        final String userAgent;

        PlaylistEntry(String url, String referrer, String userAgent) {
            this.url = url;
            this.referrer = referrer;
            this.userAgent = userAgent;
        }

        static PlaylistEntry parse(String content) throws Exception {
            final String referrerPrefix = "#EXTVLCOPT:http-referrer=";
            final String userAgentPrefix = "#EXTVLCOPT:http-user-agent=";
            String stream = null;
            String referrer = null;
            String userAgent = null;
            for (String raw : content.replace("\r", "").split("\n")) {
                String line = raw.trim();
                if (line.startsWith(referrerPrefix)) referrer = line.substring(referrerPrefix.length()).trim();
                else if (line.startsWith(userAgentPrefix)) userAgent = line.substring(userAgentPrefix.length()).trim();
                else if (!line.isEmpty() && !line.startsWith("#") && stream == null) stream = line;
            }
            if (stream == null) throw new IllegalArgumentException("The playlist contains no stream URL.");
            URL parsed = new URL(stream);
            if (!"http".equals(parsed.getProtocol()) && !"https".equals(parsed.getProtocol())) throw new IllegalArgumentException("Only HTTP and HTTPS streams are supported.");
            if (referrer == null || referrer.trim().isEmpty()) referrer = new URL(stream).getProtocol() + "://" + new URL(stream).getAuthority() + "/";
            URL parsedReferrer = new URL(referrer);
            if (!"http".equals(parsedReferrer.getProtocol()) && !"https".equals(parsedReferrer.getProtocol())) throw new IllegalArgumentException("The playlist referrer is invalid.");
            if (userAgent == null || userAgent.trim().isEmpty()) userAgent = "StreamBridge-VLC-Bridge/0.1";
            return new PlaylistEntry(parsed.toString(), parsedReferrer.toString(), userAgent.replace("\r", " ").replace("\n", " "));
        }
    }
}
