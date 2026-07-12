package com.streambridge.bridge;

import java.io.ByteArrayOutputStream;
import java.io.ByteArrayInputStream;
import java.io.Closeable;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class LoopbackProxy implements Closeable {
    private static final int MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
    private static final Pattern URI_ATTRIBUTE = Pattern.compile("URI=\"([^\"]+)\"");
    private static final SecureRandom RANDOM = new SecureRandom();

    private final String upstream;
    private final String referrer;
    private final String userAgent;
    private final String token;
    private final ExecutorService workers = Executors.newFixedThreadPool(6);
    private ServerSocket server;
    private volatile boolean closed;

    LoopbackProxy(String upstream, String referrer, String userAgent) throws Exception {
        requireHttp(upstream);
        requireHttp(referrer);
        this.upstream = upstream;
        this.referrer = referrer;
        this.userAgent = userAgent == null || userAgent.trim().isEmpty() ? "StreamBridge-VLC-Bridge/0.1" : userAgent;
        byte[] secret = new byte[24];
        RANDOM.nextBytes(secret);
        this.token = Base64.getUrlEncoder().withoutPadding().encodeToString(secret);
    }

    void start() throws Exception {
        server = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"));
        Thread acceptor = new Thread(this::acceptLoop, "streambridge-loopback");
        acceptor.setDaemon(true);
        acceptor.start();
    }

    String playbackUrl() {
        return proxyUrl(upstream);
    }

    private void acceptLoop() {
        while (!closed) {
            try {
                Socket socket = server.accept();
                socket.setSoTimeout(30_000);
                workers.execute(() -> handle(socket));
            } catch (Exception error) {
                if (!closed) error.printStackTrace();
            }
        }
    }

    private void handle(Socket socket) {
        try (socket; InputStream input = socket.getInputStream(); OutputStream output = socket.getOutputStream()) {
            Request request = Request.read(input);
            if (request == null || !("GET".equals(request.method) || "HEAD".equals(request.method))) {
                sendError(output, 405, "Method Not Allowed");
                return;
            }
            URI local = new URI(request.target);
            if (!local.getPath().equals("/stream/" + token)) {
                sendError(output, 404, "Not Found");
                return;
            }
            String encoded = query(local.getRawQuery()).get("u");
            if (encoded == null) { sendError(output, 400, "Missing stream URL"); return; }
            String target = new String(Base64.getUrlDecoder().decode(encoded), StandardCharsets.UTF_8);
            requireHttp(target);
            proxy(request, target, output);
        } catch (Exception error) {
            try { sendError(socket.getOutputStream(), 502, "Upstream playback failed"); } catch (Exception ignored) {}
        }
    }

    private void proxy(Request request, String target, OutputStream output) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(target).openConnection();
        connection.setConnectTimeout(12_000);
        connection.setReadTimeout(30_000);
        connection.setInstanceFollowRedirects(true);
        connection.setRequestMethod(request.method);
        connection.setRequestProperty("Referer", referrer);
        connection.setRequestProperty("User-Agent", userAgent);
        connection.setRequestProperty("Accept", "*/*");
        String range = request.headers.get("range");
        if (range != null) connection.setRequestProperty("Range", range);
        int status = connection.getResponseCode();
        String contentType = connection.getContentType();
        InputStream body = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        if (body == null) body = new ByteArrayInputStream(new byte[0]);
        boolean manifest = target.toLowerCase(Locale.ROOT).contains(".m3u8") || (contentType != null && contentType.toLowerCase(Locale.ROOT).contains("mpegurl"));
        if (manifest && status < 400 && !"HEAD".equals(request.method)) {
            byte[] source = readBounded(body, MAX_MANIFEST_BYTES);
            byte[] rewritten = rewrite(new String(source, StandardCharsets.UTF_8), connection.getURL().toString()).getBytes(StandardCharsets.UTF_8);
            writeStatus(output, status, reason(connection, status));
            header(output, "Content-Type", "application/vnd.apple.mpegurl");
            header(output, "Content-Length", Integer.toString(rewritten.length));
            header(output, "Cache-Control", "no-store");
            header(output, "Connection", "close");
            output.write("\r\n".getBytes(StandardCharsets.US_ASCII));
            output.write(rewritten);
            return;
        }
        writeStatus(output, status, reason(connection, status));
        copyHeader(connection, output, "Content-Type");
        copyHeader(connection, output, "Content-Length");
        copyHeader(connection, output, "Content-Range");
        copyHeader(connection, output, "Accept-Ranges");
        copyHeader(connection, output, "Cache-Control");
        header(output, "Connection", "close");
        output.write("\r\n".getBytes(StandardCharsets.US_ASCII));
        if (!"HEAD".equals(request.method)) {
            byte[] buffer = new byte[64 * 1024];
            for (int count; (count = body.read(buffer)) != -1;) output.write(buffer, 0, count);
        }
        body.close();
        connection.disconnect();
    }

    private String rewrite(String manifest, String base) throws Exception {
        StringBuilder output = new StringBuilder(manifest.length() * 2);
        for (String raw : manifest.replace("\r", "").split("\n", -1)) {
            String line = raw.trim();
            if (!line.isEmpty() && !line.startsWith("#")) {
                output.append(proxyUrl(new URL(new URL(base), line).toString()));
            } else if (line.contains("URI=\"")) {
                Matcher matcher = URI_ATTRIBUTE.matcher(raw);
                StringBuffer changed = new StringBuffer();
                while (matcher.find()) {
                    String replacement = "URI=\"" + proxyUrl(new URL(new URL(base), matcher.group(1)).toString()) + "\"";
                    matcher.appendReplacement(changed, Matcher.quoteReplacement(replacement));
                }
                matcher.appendTail(changed);
                output.append(changed);
            } else output.append(raw);
            output.append('\n');
        }
        return output.toString();
    }

    private String proxyUrl(String value) {
        String encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8));
        return "http://127.0.0.1:" + server.getLocalPort() + "/stream/" + token + "?u=" + encoded;
    }

    private static void requireHttp(String value) throws Exception {
        if (value == null) throw new IllegalArgumentException("Missing HTTP stream URL.");
        URL url = new URL(value);
        if (!("http".equals(url.getProtocol()) || "https".equals(url.getProtocol()))) throw new IllegalArgumentException("Only HTTP and HTTPS are supported.");
        if (url.getUserInfo() != null) throw new IllegalArgumentException("URL credentials are not supported.");
    }

    private static Map<String, String> query(String raw) throws Exception {
        Map<String, String> result = new HashMap<>();
        if (raw == null) return result;
        for (String field : raw.split("&")) {
            int split = field.indexOf('=');
            if (split > 0) result.put(URLDecoder.decode(field.substring(0, split), "UTF-8"), URLDecoder.decode(field.substring(split + 1), "UTF-8"));
        }
        return result;
    }

    private static byte[] readBounded(InputStream input, int maximum) throws Exception {
        try (input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16_384];
            int total = 0;
            for (int count; (count = input.read(buffer)) != -1;) {
                total += count;
                if (total > maximum) throw new IllegalArgumentException("HLS manifest exceeds 2 MiB.");
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }

    private static void copyHeader(HttpURLConnection connection, OutputStream output, String name) throws Exception {
        String value = connection.getHeaderField(name);
        if (value != null) header(output, name, value);
    }

    private static String reason(HttpURLConnection connection, int status) {
        try { String value = connection.getResponseMessage(); return value == null ? Integer.toString(status) : value; }
        catch (Exception ignored) { return Integer.toString(status); }
    }

    private static void writeStatus(OutputStream output, int status, String reason) throws Exception {
        output.write(("HTTP/1.1 " + status + " " + reason.replace("\r", " ").replace("\n", " ") + "\r\n").getBytes(StandardCharsets.US_ASCII));
    }

    private static void header(OutputStream output, String name, String value) throws Exception {
        output.write((name + ": " + value.replace("\r", " ").replace("\n", " ") + "\r\n").getBytes(StandardCharsets.US_ASCII));
    }

    private static void sendError(OutputStream output, int status, String message) throws Exception {
        byte[] body = message.getBytes(StandardCharsets.UTF_8);
        writeStatus(output, status, message);
        header(output, "Content-Type", "text/plain; charset=utf-8");
        header(output, "Content-Length", Integer.toString(body.length));
        header(output, "Connection", "close");
        output.write("\r\n".getBytes(StandardCharsets.US_ASCII));
        output.write(body);
    }

    @Override public void close() {
        closed = true;
        try { if (server != null) server.close(); } catch (Exception ignored) {}
        workers.shutdownNow();
    }

    private static final class Request {
        final String method;
        final String target;
        final Map<String, String> headers;

        Request(String method, String target, Map<String, String> headers) {
            this.method = method;
            this.target = target;
            this.headers = headers;
        }

        static Request read(InputStream input) throws Exception {
            String head = readHead(input);
            if (head == null) return null;
            String[] lines = head.split("\r\n");
            String[] request = lines[0].split(" ", 3);
            if (request.length < 2) return null;
            Map<String, String> headers = new HashMap<>();
            for (int index = 1; index < lines.length; index++) {
                int split = lines[index].indexOf(':');
                if (split > 0) headers.put(lines[index].substring(0, split).trim().toLowerCase(Locale.ROOT), lines[index].substring(split + 1).trim());
            }
            return new Request(request[0], request[1], headers);
        }

        private static String readHead(InputStream input) throws Exception {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            int matched = 0;
            while (output.size() < 32_768) {
                int value = input.read();
                if (value == -1) return output.size() == 0 ? null : output.toString(StandardCharsets.US_ASCII);
                output.write(value);
                int expected = "\r\n\r\n".charAt(matched);
                matched = value == expected ? matched + 1 : (value == '\r' ? 1 : 0);
                if (matched == 4) return output.toString(StandardCharsets.US_ASCII);
            }
            throw new IllegalArgumentException("HTTP request headers are too large.");
        }
    }
}
