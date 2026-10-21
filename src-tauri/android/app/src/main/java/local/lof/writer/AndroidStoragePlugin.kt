package local.lof.writer

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.Settings
import androidx.activity.result.ActivityResult
import androidx.annotation.Keep
import androidx.core.content.ContextCompat
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@Keep
@TauriPlugin(
  permissions = [Permission(strings = [Manifest.permission.WRITE_EXTERNAL_STORAGE], alias = "storage")]
)
class AndroidStoragePlugin(private val activity: Activity) : Plugin(activity) {
  private fun hasAccess(): Boolean =
    if (Build.VERSION.SDK_INT >= 30) Environment.isExternalStorageManager()
    else ContextCompat.checkSelfPermission(activity, Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED

  @Command
  fun pickFolder(invoke: Invoke) {
    if (hasAccess()) {
      openTree(invoke)
    } else if (Build.VERSION.SDK_INT >= 30) {
      try {
        startActivityForResult(invoke, Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:${activity.packageName}")), "accessResult")
      } catch (_: Exception) {
        try {
          startActivityForResult(invoke, Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION), "accessResult")
        } catch (_: Exception) {
          invoke.reject("모든 파일 접근 권한 설정 화면을 열지 못했습니다. Android 설정에서 직접 허용해 주세요.")
        }
      }
    } else {
      requestPermissionForAlias("storage", invoke, "storagePermissionResult")
    }
  }

  @ActivityCallback
  fun accessResult(invoke: Invoke, result: ActivityResult) = continueAfterAccess(invoke)

  @PermissionCallback
  fun storagePermissionResult(invoke: Invoke) = continueAfterAccess(invoke)

  private fun continueAfterAccess(invoke: Invoke) {
    if (hasAccess()) openTree(invoke)
    else invoke.reject("기기 폴더를 서재로 쓰려면 모든 파일 접근 권한을 허용해 주세요.")
  }

  private fun openTree(invoke: Invoke) {
    try {
      startActivityForResult(invoke, Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), "treeResult")
    } catch (_: Exception) {
      invoke.reject("폴더 선택 화면을 열지 못했습니다.")
    }
  }

  @ActivityCallback
  fun treeResult(invoke: Invoke, result: ActivityResult) {
    val uri = result.data?.data
    if (result.resultCode != Activity.RESULT_OK || uri == null) {
      invoke.resolve(JSObject().apply { put("path", null) })
      return
    }
    val path = treePath(uri)
    if (path == null) {
      invoke.reject("이 위치는 서재로 쓸 수 없습니다. 내부 저장공간이나 SD 카드의 폴더를 선택해 주세요.")
      return
    }
    val folder = File(path)
    if (!folder.isDirectory || !folder.canWrite()) {
      invoke.reject("선택한 폴더에 저장할 수 없습니다. 다른 폴더를 선택해 주세요.")
      return
    }
    invoke.resolve(JSObject().apply { put("path", folder.absolutePath) })
  }

  // 시스템 폴더 선택기가 돌려준 저장소 문서 주소를 실제 파일 경로로 바꾼다.
  private fun treePath(uri: Uri): String? {
    if (uri.authority != "com.android.externalstorage.documents") return null
    val documentId = DocumentsContract.getTreeDocumentId(uri)
    val volume = documentId.substringBefore(':')
    val relative = documentId.substringAfter(':', "").trim('/')
    val base = when {
      volume.equals("primary", ignoreCase = true) -> Environment.getExternalStorageDirectory().absolutePath
      volume.matches(Regex("[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}")) -> "/storage/$volume"
      else -> return null
    }
    return if (relative.isEmpty()) base else "$base/$relative"
  }
}
