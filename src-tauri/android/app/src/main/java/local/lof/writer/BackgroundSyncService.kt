package local.lof.writer

import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.ServiceCompat

/** 앱을 닫은 뒤 알림을 띄워 두고, 30분 동안 연결이 끊기지 않게 기기를 깨워 둔다. */
class BackgroundSyncService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private var wakeLock: PowerManager.WakeLock? = null
  private val endLive = Runnable {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    if (BackgroundSync.mode(this) == "always") show(false) else stopSelf()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun show(live: Boolean): Boolean = try {
    ServiceCompat.startForeground(
      this,
      BackgroundSync.NOTIFICATION_ID,
      BackgroundSync.notification(this, live),
      if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0
    )
    true
  } catch (_: Exception) {
    false
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (!show(true)) {
      stopSelf()
      return START_NOT_STICKY
    }
    if (wakeLock == null) {
      wakeLock = getSystemService(PowerManager::class.java)
        ?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "lof:live-sync")
        ?.apply {
          setReferenceCounted(false)
          acquire(BackgroundSync.LIVE_MILLIS)
        }
      handler.postDelayed(endLive, BackgroundSync.LIVE_MILLIS)
    }
    return START_NOT_STICKY
  }

  // Android 15부터 데이터 동기화 서비스의 하루 실행 시간이 끝나면 호출된다.
  override fun onTimeout(startId: Int, fgsType: Int) {
    stopSelf()
  }

  override fun onDestroy() {
    handler.removeCallbacks(endLive)
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    super.onDestroy()
  }
}

/** 주기 확인 알람. 앱이 멈춰 있어도 잠시 깨어나 동기화를 확인한다. */
class BackgroundSyncReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    BackgroundSync.fire(context.applicationContext, goAsync())
  }
}
