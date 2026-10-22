package local.lof.writer

import android.Manifest
import android.app.Activity
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import androidx.annotation.Keep
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

/** 앱을 닫은 뒤의 동기화 유지 상태. 알림 서비스와 주기 확인 알람이 함께 사용한다. */
object BackgroundSync {
  const val LIVE_MILLIS = 30L * 60 * 1000
  const val NOTIFICATION_ID = 7301
  private const val CHANNEL = "background-sync"
  private const val PREFS = "background-sync"
  // 주기 확인을 마칠 때까지 앱이 멈추지 않도록 붙잡는 최대 시간.
  private const val HOLD_MILLIS = 50_000L
  private val lock = Any()
  private val handler = Handler(Looper.getMainLooper())
  private val timeout = Runnable { release() }
  @Volatile var attached = false
  private var waiting: Invoke? = null
  private var missed = false
  private var hold: BroadcastReceiver.PendingResult? = null
  private var wakeLock: PowerManager.WakeLock? = null

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
  fun mode(context: Context) = prefs(context).getString("mode", "live") ?: "live"
  private fun active(context: Context) = prefs(context).getBoolean("active", false)

  fun configure(context: Context, mode: String, active: Boolean) {
    prefs(context).edit().putString("mode", mode).putBoolean("active", active).apply()
  }

  fun appHidden(context: Context) {
    if (!active(context) || mode(context) == "off") return
    try {
      ContextCompat.startForegroundService(context, Intent(context, BackgroundSyncService::class.java))
    } catch (_: Exception) {
      // Android가 서비스 시작을 막으면 알림 없이 주기 확인만 사용한다.
    }
  }

  fun appVisible(context: Context) {
    context.stopService(Intent(context, BackgroundSyncService::class.java))
  }

  private fun alarm(context: Context): PendingIntent = PendingIntent.getBroadcast(
    context, 0, Intent(context, BackgroundSyncReceiver::class.java),
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
  )

  fun schedule(context: Context, delayMillis: Long) {
    val manager = context.getSystemService(AlarmManager::class.java) ?: return
    // 대기 모드에서도 울리는 일반 알람. Android가 배터리 상태에 따라 조금 늦출 수 있다.
    manager.setAndAllowWhileIdle(
      AlarmManager.ELAPSED_REALTIME_WAKEUP,
      SystemClock.elapsedRealtime() + delayMillis.coerceAtLeast(1_000L),
      alarm(context)
    )
  }

  fun cancel(context: Context) {
    context.getSystemService(AlarmManager::class.java)?.cancel(alarm(context))
  }

  /** 알람이 울리면 앱이 확인을 마칠 때까지 깨어 있게 하고 동기화 작업에 알린다. */
  fun fire(context: Context, result: BroadcastReceiver.PendingResult) {
    if (!attached) {
      result.finish()
      return
    }
    synchronized(lock) {
      release()
      hold = result
      val power = context.getSystemService(PowerManager::class.java)
      wakeLock = power?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "lof:sync-check")?.apply {
        setReferenceCounted(false)
        acquire(HOLD_MILLIS)
      }
      handler.postDelayed(timeout, HOLD_MILLIS)
      val call = waiting
      if (call != null) {
        waiting = null
        call.resolve()
      } else {
        missed = true
      }
    }
  }

  fun wait(invoke: Invoke) {
    synchronized(lock) {
      if (missed) {
        missed = false
        invoke.resolve()
      } else {
        waiting = invoke
      }
    }
  }

  fun release() {
    synchronized(lock) {
      handler.removeCallbacks(timeout)
      hold?.finish()
      hold = null
      wakeLock?.let { if (it.isHeld) it.release() }
      wakeLock = null
    }
  }

  fun notification(context: Context, live: Boolean): Notification {
    if (Build.VERSION.SDK_INT >= 26) {
      context.getSystemService(NotificationManager::class.java)?.createNotificationChannel(
        NotificationChannel(CHANNEL, "백그라운드 동기화", NotificationManager.IMPORTANCE_LOW)
      )
    }
    val open = context.packageManager.getLaunchIntentForPackage(context.packageName)
    val content = open?.let {
      PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
    return NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
      .setContentTitle(if (live) "실시간 동기화 중" else "주기 동기화 중")
      .setOngoing(true)
      .setSilent(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setContentIntent(content)
      .build()
  }
}

/** Android는 네이티브 코드에 네트워크 변경을 알리지 않으므로 기본 네트워크 변경을 실시간 연결에 전달한다. */
object NetworkWatch {
  private val lock = Any()
  private var registered = false
  private var waiting: Invoke? = null
  private var missed = false
  private var last: String? = null

  fun start(context: Context) {
    synchronized(lock) {
      if (registered) return
      registered = true
    }
    val manager = context.getSystemService(ConnectivityManager::class.java)
    if (manager == null) {
      synchronized(lock) { registered = false }
      return
    }
    try {
      manager.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = changed(key(network, manager.getLinkProperties(network)))
        override fun onLost(network: Network) = changed(null)
        // 같은 네트워크에서 주소만 바뀌는 경우도 알린다.
        override fun onLinkPropertiesChanged(network: Network, properties: LinkProperties) = changed(key(network, properties))
      })
    } catch (_: Exception) {
      synchronized(lock) { registered = false }
    }
  }

  // DNS·경로 정보만 갱신된 알림은 무시하도록 네트워크와 주소 목록으로 비교한다.
  private fun key(network: Network, properties: LinkProperties?): String =
    "$network:" + (properties?.linkAddresses?.map { it.toString() }?.sorted()?.joinToString(",") ?: "")

  private fun changed(key: String?) {
    synchronized(lock) {
      if (key == last) return
      last = key
      val call = waiting
      if (call != null) {
        waiting = null
        call.resolve()
      } else {
        missed = true
      }
    }
  }

  fun wait(invoke: Invoke) {
    synchronized(lock) {
      if (missed) {
        missed = false
        invoke.resolve()
      } else {
        waiting = invoke
      }
    }
  }
}

@Keep
@TauriPlugin
class BackgroundSyncPlugin(private val activity: Activity) : Plugin(activity) {
  init {
    BackgroundSync.attached = true
    NetworkWatch.start(activity.applicationContext)
  }

  @Command
  fun configure(invoke: Invoke) {
    val args = invoke.getArgs()
    BackgroundSync.configure(activity.applicationContext, args.optString("mode", "live"), args.optBoolean("active", false))
    invoke.resolve()
  }

  @Command
  fun scheduleAlarm(invoke: Invoke) {
    BackgroundSync.schedule(activity.applicationContext, invoke.getArgs().optLong("delayMs", 300_000L))
    invoke.resolve()
  }

  @Command
  fun cancelAlarm(invoke: Invoke) {
    BackgroundSync.cancel(activity.applicationContext)
    invoke.resolve()
  }

  @Command
  fun waitAlarm(invoke: Invoke) = BackgroundSync.wait(invoke)

  @Command
  fun waitNetwork(invoke: Invoke) = NetworkWatch.wait(invoke)

  @Command
  fun releaseWake(invoke: Invoke) {
    BackgroundSync.release()
    invoke.resolve()
  }

  @Command
  fun requestNotifications(invoke: Invoke) {
    if (Build.VERSION.SDK_INT >= 33 &&
      ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), BackgroundSync.NOTIFICATION_ID)
    }
    invoke.resolve()
  }
}
