package local.lof.writer

import android.content.ClipboardManager
import android.graphics.Color
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject
import java.io.File
import java.util.IdentityHashMap

class MainActivity : TauriActivity() {
  override val handleBackNavigation: Boolean = false
  private var webView: WebView? = null
  private var pinCoverView: View? = null
  private var imeVisible = false
  private var activeActionMode: ActionMode? = null
  @Volatile private var externalScreenOpen = false
  @Volatile private var canBookmark = false
  @Volatile private var bookmarked = false
  @Volatile private var canQuickNote = false
  @Volatile private var canPaste = false

  companion object {
    private const val MENU_ID_BOOKMARK = 0x70f10001
    private const val MENU_ID_QUICK_NOTE = 0x70f10002
    private const val MENU_ID_PASTE = 0x70f10003
  }

  private fun isPinEnabled(): Boolean = File(filesDir, "pin.json").isFile

  private fun updateRecentsPrivacy() {
    val enabled = isPinEnabled()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      setRecentsScreenshotEnabled(!enabled)
    } else if (enabled) {
      window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    } else {
      window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }
  }

  private fun resolveThemeStyle(): Pair<Int, Boolean> {
    return try {
      val raw = File(filesDir, "settings.json").readText()
      val prefs = JSONObject(raw).optJSONObject("preferences")
      val dark = prefs?.optString("theme") == "dark"
      val bakery = prefs?.optString("colorTheme") == "bakery"
      val color = when {
        bakery && dark -> 0xFF151515.toInt()
        bakery -> 0xFFFCFCFB.toInt()
        dark -> 0xFF1F1F1F.toInt()
        else -> 0xFFFFFFFF.toInt()
      }
      color to dark
    } catch (_: Exception) {
      0xFFFFFFFF.toInt() to false
    }
  }

  private fun showPinCover() {
    val (color, _) = resolveThemeStyle()
    pinCoverView?.let { cover ->
      cover.setBackgroundColor(color)
      cover.visibility = View.VISIBLE
    }
  }

  inner class EditorContextMenuBridge {
    @JavascriptInterface
    fun setContextState(canBookmark: Boolean, bookmarked: Boolean, canQuickNote: Boolean, canPaste: Boolean) {
      val changed =
        this@MainActivity.canBookmark != canBookmark ||
          this@MainActivity.bookmarked != bookmarked ||
          this@MainActivity.canQuickNote != canQuickNote ||
          this@MainActivity.canPaste != canPaste
      this@MainActivity.canBookmark = canBookmark
      this@MainActivity.bookmarked = bookmarked
      this@MainActivity.canQuickNote = canQuickNote
      this@MainActivity.canPaste = canPaste
      if (changed) {
        runOnUiThread {
          activeActionMode?.invalidate()
        }
      }
    }

    @JavascriptInterface
    fun setExternalScreenOpen(open: Boolean) {
      this@MainActivity.externalScreenOpen = open
    }

    @JavascriptInterface
    fun refreshPinPrivacy() {
      runOnUiThread { updateRecentsPrivacy() }
    }

    @JavascriptInterface
    fun setPinCoverVisible(visible: Boolean) {
      runOnUiThread {
        if (visible) {
          showPinCover()
        } else {
          pinCoverView?.visibility = View.GONE
        }
      }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    val (bgColor, isDark) = resolveThemeStyle()
    val barStyle = if (isDark) {
      SystemBarStyle.dark(Color.TRANSPARENT)
    } else {
      SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
    }
    enableEdgeToEdge(barStyle, barStyle)
    super.onCreate(savedInstanceState)
    updateRecentsPrivacy()
    window.decorView.setBackgroundColor(bgColor)
    val contentView = findViewById<android.view.View>(android.R.id.content)
    contentView.setBackgroundColor(bgColor)
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
      val (bgColor, _) = resolveThemeStyle()
      view.setBackgroundColor(bgColor)
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
      val cover = View(this).apply {
        setBackgroundColor(bgColor)
        isClickable = true
        isFocusable = true
        visibility = if (isPinEnabled()) View.VISIBLE else View.GONE
      }
      pinCoverView = cover
      container.addView(
        view,
        FrameLayout.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT,
          ViewGroup.LayoutParams.MATCH_PARENT
        )
      )
      container.addView(
        cover,
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
    for (index in menu.size() - 1 downTo 0) {
      val item = menu.getItem(index)
      val resourceName = try { webView?.resources?.getResourceName(item.itemId) } catch (_: Exception) { null }
      if (item.intent?.action == "com.samsung.android.intent.action.WritingToolkit" ||
        resourceName == "android:id/writing_toolkit") {
        menu.removeItem(item.itemId)
        changed = true
      }
    }
    val existingBookmark = menu.findItem(MENU_ID_BOOKMARK)
    val bookmarkTitle = if (bookmarked) "북마크 해제" else "북마크"
    if (canBookmark) {
      if (existingBookmark == null) {
        menu.add(Menu.NONE, MENU_ID_BOOKMARK, 10, bookmarkTitle)
          .setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM)
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
        menu.add(Menu.NONE, MENU_ID_QUICK_NOTE, 11, "퀵노트")
          .setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM)
        changed = true
      }
    } else if (existingQuickNote != null) {
      menu.removeItem(MENU_ID_QUICK_NOTE)
      changed = true
    }
    val nativePaste = (0 until menu.size()).any { index ->
      val item = menu.getItem(index)
      item.itemId != MENU_ID_PASTE && item.isVisible && item.isEnabled && clipboardActionOrder(item) == 2
    }
    val clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
    val showPaste = canPaste && !nativePaste && clipboard.hasPrimaryClip() &&
      clipboard.primaryClipDescription?.hasMimeType("text/*") == true
    if (showPaste && menu.findItem(MENU_ID_PASTE) == null) {
      menu.add(Menu.NONE, MENU_ID_PASTE, 2, getString(android.R.string.paste))
        .setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS)
      changed = true
    } else if (!showPaste && menu.findItem(MENU_ID_PASTE) != null) {
      menu.removeItem(MENU_ID_PASTE)
      changed = true
    }
    return changed
  }

  private fun clipboardActionOrder(item: MenuItem): Int? {
    when (item.itemId) {
      android.R.id.copy -> return 0
      android.R.id.cut -> return 1
      android.R.id.paste, MENU_ID_PASTE -> return 2
      android.R.id.pasteAsPlainText -> return 3
      android.R.id.selectAll -> return 4
    }
    // WebView 버전에 따라 기본 편집 항목이 자체 리소스 ID를 사용한다.
    val name = try { webView?.resources?.getResourceEntryName(item.itemId) } catch (_: Exception) { null }
    return when (name) {
      "select_action_menu_copy" -> 0
      "select_action_menu_cut" -> 1
      "select_action_menu_paste" -> 2
      "select_action_menu_paste_as_plain_text" -> 3
      "select_action_menu_select_all" -> 4
      else -> when (item.title?.toString()) {
        getString(android.R.string.copy) -> 0
        getString(android.R.string.cut) -> 1
        getString(android.R.string.paste) -> 2
        getString(android.R.string.selectAll) -> 4
        else -> null
      }
    }
  }

  private fun prioritizeEditorActions(menu: Menu, originals: IdentityHashMap<MenuItem, MenuItem>): Boolean {
    // 원래 항목을 보관해 WebView 콜백에는 기존 ID·그룹·순서와 Intent를 전달한다.
    val items = (0 until menu.size()).map { menu.getItem(it) }
    // 하위 메뉴를 가진 항목은 구조를 유지한다.
    if (items.any { it.hasSubMenu() }) return false
    val sources = items.map { originals[it] ?: it }
    val hasSelection = items.any {
      it.isVisible && it.isEnabled && clipboardActionOrder(it) in 0..1
    }
    originals.clear()
    menu.clear()
    items.forEachIndexed { index, item ->
      val priority = clipboardActionOrder(item)
      val order = when {
        priority == 0 || priority == 1 -> priority
        item.itemId == MENU_ID_BOOKMARK -> 2
        item.itemId == MENU_ID_QUICK_NOTE -> 3
        priority == 2 -> if (hasSelection) 4 else 0
        priority != null -> priority + 2
        else -> 100 + index
      }
      val replacement = menu.add(item.groupId, item.itemId, order, item.title)
      replacement.icon = item.icon
      replacement.intent = item.intent
      replacement.isCheckable = item.isCheckable
      replacement.isChecked = item.isChecked
      replacement.isVisible = item.isVisible
      replacement.isEnabled = item.isEnabled
      replacement.titleCondensed = item.titleCondensed
      replacement.setShowAsAction(if (order < 4) MenuItem.SHOW_AS_ACTION_ALWAYS else MenuItem.SHOW_AS_ACTION_IF_ROOM)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        replacement.contentDescription = item.contentDescription
        replacement.tooltipText = item.tooltipText
      }
      originals[replacement] = sources[index]
    }
    return true
  }

  private fun wrapActionModeCallback(callback: ActionMode.Callback): ActionMode.Callback2 {
    return object : ActionMode.Callback2() {
      private val originals = IdentityHashMap<MenuItem, MenuItem>()

      override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
        activeActionMode = mode
        val created = callback.onCreateActionMode(mode, menu)
        val added = applyEditorActionMenu(menu)
        prioritizeEditorActions(menu, originals)
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
        val reordered = prioritizeEditorActions(menu, originals)
        return prepared || changed || reordered
      }

      override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
        when (item.itemId) {
          MENU_ID_PASTE -> {
            if (canPaste) {
              val clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
              val text = clipboard.primaryClip?.getItemAt(0)?.coerceToText(this@MainActivity)?.toString()
              if (!text.isNullOrEmpty()) {
                webView?.evaluateJavascript(
                  "(function(){ if (typeof window.__lofPasteEditorText === 'function') window.__lofPasteEditorText(${JSONObject.quote(text)}); })()"
                ) { mode.finish() }
              }
            }
            return true
          }
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
        return callback.onActionItemClicked(mode, originals[item] ?: item)
      }

      override fun onDestroyActionMode(mode: ActionMode) {
        originals.clear()
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
    updateRecentsPrivacy()
    BackgroundSync.appVisible(this)
  }

  override fun onPause() {
    updateRecentsPrivacy()
    super.onPause()
  }

  override fun onStop() {
    super.onStop()
    // 백그라운드로 내려가는 즉시 잠금 가림막을 올리고 알림 서비스를 시작한다.
    if (!isChangingConfigurations) {
      if (!externalScreenOpen && isPinEnabled()) {
        showPinCover()
      }
      BackgroundSync.appHidden(this)
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    this.webView = webView
    // 선택 확대경이 이동할 때도 웹 화면을 독립된 GPU 레이어에서 합성한다.
    webView.setLayerType(View.LAYER_TYPE_HARDWARE, null)
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
