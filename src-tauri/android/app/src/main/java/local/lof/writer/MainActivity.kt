package local.lof.writer

import android.graphics.Rect
import android.os.Bundle
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override val handleBackNavigation: Boolean = false
  private var webView: WebView? = null
  private var imeVisible = false
  private var activeActionMode: ActionMode? = null
  @Volatile private var canBookmark = false
  @Volatile private var bookmarked = false
  @Volatile private var canQuickNote = false

  companion object {
    private const val MENU_ID_BOOKMARK = 0x70f10001
    private const val MENU_ID_QUICK_NOTE = 0x70f10002
  }

  inner class EditorContextMenuBridge {
    @JavascriptInterface
    fun setContextState(canBookmark: Boolean, bookmarked: Boolean, canQuickNote: Boolean) {
      val changed =
        this@MainActivity.canBookmark != canBookmark ||
          this@MainActivity.bookmarked != bookmarked ||
          this@MainActivity.canQuickNote != canQuickNote
      this@MainActivity.canBookmark = canBookmark
      this@MainActivity.bookmarked = bookmarked
      this@MainActivity.canQuickNote = canQuickNote
      if (changed) {
        runOnUiThread {
          activeActionMode?.invalidate()
        }
      }
    }
  }

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

  override fun setContentView(view: View?) {
    if (view is WebView) {
      (view.parent as? ViewGroup)?.removeView(view)
      val container = object : FrameLayout(this) {
        override fun startActionModeForChild(
          originalView: View?,
          callback: ActionMode.Callback?,
          type: Int
        ): ActionMode? {
          return super.startActionModeForChild(
            originalView,
            if (callback != null) wrapActionModeCallback(callback) else null,
            type
          )
        }

        override fun startActionModeForChild(
          originalView: View?,
          callback: ActionMode.Callback?
        ): ActionMode? {
          return super.startActionModeForChild(
            originalView,
            if (callback != null) wrapActionModeCallback(callback) else null
          )
        }
      }
      container.addView(
        view,
        FrameLayout.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT,
          ViewGroup.LayoutParams.MATCH_PARENT
        )
      )
      super.setContentView(container)
      return
    }
    super.setContentView(view)
  }

  private fun applyEditorActionMenu(menu: Menu): Boolean {
    var changed = false
    val existingBookmark = menu.findItem(MENU_ID_BOOKMARK)
    val bookmarkTitle = if (bookmarked) "북마크 해제" else "북마크"
    if (canBookmark) {
      if (existingBookmark == null) {
        menu.add(Menu.NONE, MENU_ID_BOOKMARK, 3, bookmarkTitle)
          .setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS)
        changed = true
      } else if (existingBookmark.title != bookmarkTitle) {
        existingBookmark.title = bookmarkTitle
        changed = true
      }
    } else if (existingBookmark != null) {
      menu.removeItem(MENU_ID_BOOKMARK)
      changed = true
    }

    val existingQuickNote = menu.findItem(MENU_ID_QUICK_NOTE)
    if (canQuickNote) {
      if (existingQuickNote == null) {
        menu.add(Menu.NONE, MENU_ID_QUICK_NOTE, 3, "퀵노트")
          .setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS)
        changed = true
      }
    } else if (existingQuickNote != null) {
      menu.removeItem(MENU_ID_QUICK_NOTE)
      changed = true
    }
    return changed
  }

  private fun wrapActionModeCallback(callback: ActionMode.Callback): ActionMode.Callback2 {
    return object : ActionMode.Callback2() {
      override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
        activeActionMode = mode
        val created = callback.onCreateActionMode(mode, menu)
        val added = applyEditorActionMenu(menu)
        webView?.evaluateJavascript(
          "(function(){ try { if (typeof window.__lofSyncEditorContextState === 'function') window.__lofSyncEditorContextState(); } catch(e) {} })()",
          null
        )
        return created || added || menu.size() > 0
      }

      override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean {
        activeActionMode = mode
        val prepared = callback.onPrepareActionMode(mode, menu)
        val changed = applyEditorActionMenu(menu)
        return prepared || changed
      }

      override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
        when (item.itemId) {
          MENU_ID_BOOKMARK -> {
            webView?.evaluateJavascript(
              "(function(){ try { if (typeof window.__lofEditorContextAction === 'function') window.__lofEditorContextAction('bookmark'); } catch(e) {} })()"
            ) {
              mode.finish()
            }
            return true
          }
          MENU_ID_QUICK_NOTE -> {
            webView?.evaluateJavascript(
              "(function(){ try { if (typeof window.__lofEditorContextAction === 'function') window.__lofEditorContextAction('quickNote'); } catch(e) {} })()"
            ) {
              mode.finish()
            }
            return true
          }
        }
        return callback.onActionItemClicked(mode, item)
      }

      override fun onDestroyActionMode(mode: ActionMode) {
        if (activeActionMode === mode) {
          activeActionMode = null
        }
        callback.onDestroyActionMode(mode)
      }

      override fun onGetContentRect(mode: ActionMode, view: View?, outRect: Rect) {
        if (callback is ActionMode.Callback2) {
          callback.onGetContentRect(mode, view, outRect)
        } else {
          super.onGetContentRect(mode, view, outRect)
        }
      }
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
    webView.addJavascriptInterface(EditorContextMenuBridge(), "lofAndroidEditor")
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
