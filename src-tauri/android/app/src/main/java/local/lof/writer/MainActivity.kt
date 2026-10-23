package local.lof.writer

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override val handleBackNavigation: Boolean = false
  private var webView: WebView? = null
  private var imeVisible = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    val contentView = findViewById<android.view.View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(contentView) { view, windowInsets ->
      val insets = windowInsets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
      )
      view.setPadding(insets.left, insets.top, insets.right, insets.bottom)
      val visible = windowInsets.isVisible(WindowInsetsCompat.Type.ime())
      // 키보드를 내리면 편집 영역 포커스도 함께 해제해 커서와 삽입 핸들을 정리한다.
      if (imeVisible && !visible) {
        webView?.evaluateJavascript(
          "(function(){ try { if (typeof window.__lofKeyboardHidden === 'function') window.__lofKeyboardHidden(); } catch(e) {} })()",
          null
        )
      }
      imeVisible = visible
      WindowInsetsCompat.CONSUMED
    }
  }

  override fun onStart() {
    super.onStart()
    BackgroundSync.appVisible(this)
  }

  override fun onStop() {
    super.onStop()
    // 백그라운드로 내려가는 즉시 시작해야 Android가 알림 서비스를 허용한다.
    if (!isChangingConfigurations) BackgroundSync.appHidden(this)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    this.webView = webView
    val callback = object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        webView.evaluateJavascript(
          "(function(){ try { return typeof window.__lofMobileBack === 'function' ? Boolean(window.__lofMobileBack()) : false; } catch(e) { return false; } })()"
        ) { result ->
          if (result != "true") {
            if (webView.canGoBack()) {
              webView.goBack()
            } else {
              isEnabled = false
              onBackPressedDispatcher.onBackPressed()
              isEnabled = true
            }
          }
        }
      }
    }
    onBackPressedDispatcher.addCallback(this, callback)
  }
}
