package local.lof.writer

import android.app.Activity
import android.graphics.Color
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.annotation.Keep
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class SystemBarsArgs {
  var color: String = "#ffffff"
  var dark: Boolean = false
}

// 앱 테마에 맞춰 상태 표시줄·내비게이션 바 뒤의 색과 아이콘 밝기를 바꾼다.
@Keep
@TauriPlugin
class AndroidSystemBarsPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun setSystemBars(invoke: Invoke) {
    val args = invoke.parseArgs(SystemBarsArgs::class.java)
    val color = try {
      Color.parseColor(args.color)
    } catch (error: IllegalArgumentException) {
      invoke.reject("시스템 바 색을 읽지 못했습니다.")
      return
    }
    activity.runOnUiThread {
      // 막대 자체는 투명하게 두고, 그 뒤에 보이는 창 배경을 앱 화면 색으로 칠한다.
      val style = if (args.dark) {
        SystemBarStyle.dark(Color.TRANSPARENT)
      } else {
        SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
      }
      (activity as? ComponentActivity)?.enableEdgeToEdge(style, style)
      activity.window.decorView.setBackgroundColor(color)
      activity.findViewById<android.view.View>(android.R.id.content)?.setBackgroundColor(color)
      invoke.resolve()
    }
  }
}
