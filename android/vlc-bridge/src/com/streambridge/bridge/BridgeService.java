package com.streambridge.bridge;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.ResultReceiver;

public final class BridgeService extends Service {
    static final String EXTRA_URL = "com.streambridge.bridge.URL";
    static final String EXTRA_REFERRER = "com.streambridge.bridge.REFERRER";
    static final String EXTRA_USER_AGENT = "com.streambridge.bridge.USER_AGENT";
    static final String EXTRA_RECEIVER = "com.streambridge.bridge.RECEIVER";
    static final String EXTRA_LOCAL_URL = "com.streambridge.bridge.LOCAL_URL";
    static final String EXTRA_ERROR = "com.streambridge.bridge.ERROR";
    static final int RESULT_READY = 1;
    private static final String ACTION_STOP = "com.streambridge.bridge.STOP";
    private static final String CHANNEL = "streambridge_bridge";
    private static final int NOTIFICATION_ID = 48_171;

    private LoopbackProxy proxy;

    @Override public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(new NotificationChannel(CHANNEL, "StreamBridge playback bridge", NotificationManager.IMPORTANCE_LOW));
        startForeground(NOTIFICATION_ID, notification());
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_NOT_STICKY;
        if (ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        ResultReceiver receiver = Build.VERSION.SDK_INT >= 33
            ? intent.getParcelableExtra(EXTRA_RECEIVER, ResultReceiver.class)
            : intent.getParcelableExtra(EXTRA_RECEIVER);
        try {
            if (proxy != null) proxy.close();
            proxy = new LoopbackProxy(
                intent.getStringExtra(EXTRA_URL),
                intent.getStringExtra(EXTRA_REFERRER),
                intent.getStringExtra(EXTRA_USER_AGENT)
            );
            proxy.start();
            Bundle data = new Bundle();
            data.putString(EXTRA_LOCAL_URL, proxy.playbackUrl());
            if (receiver != null) receiver.send(RESULT_READY, data);
        } catch (Exception error) {
            Bundle data = new Bundle();
            data.putString(EXTRA_ERROR, error.getMessage() == null ? "The loopback bridge could not start." : error.getMessage());
            if (receiver != null) receiver.send(0, data);
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    private Notification notification() {
        Intent stop = new Intent(this, BridgeService.class).setAction(ACTION_STOP);
        PendingIntent stopIntent = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle("StreamBridge is feeding VLC")
            .setContentText("Traffic stays on this device. Tap Stop when playback is finished.")
            .setOngoing(true)
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stopIntent).build())
            .build();
    }

    @Override public void onDestroy() {
        if (proxy != null) proxy.close();
        proxy = null;
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
