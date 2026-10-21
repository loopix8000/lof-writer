package local.lof.writer

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.Base64
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
import java.io.ByteArrayOutputStream
import java.io.File

@Keep
@TauriPlugin(
  permissions = [Permission(strings = [Manifest.permission.WRITE_EXTERNAL_STORAGE], alias = "storage")]
)
class AndroidStoragePlugin(private val activity: Activity) : Plugin(activity) {
  private fun hasAccess(): Boolean =
    if (Build.VERSION.SDK_INT >= 30) Environment.isExternalStorageManager()
    else ContextCompat.checkSelfPermission(activity, Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED

  private fun accessResponse() = JSObject().apply { put("granted", hasAccess()) }

  @Command
  fun accessStatus(invoke: Invoke) = invoke.resolve(accessResponse())

  // 서재는 기기 폴더에만 두므로 앱을 시작할 때 모든 파일 접근 권한을 먼저 받는다.
  @Command
  fun requestAccess(invoke: Invoke) {
    if (hasAccess()) invoke.resolve(accessResponse())
    else askAccess(invoke, "requestAccessResult", "requestPermissionResult")
  }

  @ActivityCallback
  fun requestAccessResult(invoke: Invoke, result: ActivityResult) = invoke.resolve(accessResponse())

  @PermissionCallback
  fun requestPermissionResult(invoke: Invoke) = invoke.resolve(accessResponse())

  @Command
  fun pickFolder(invoke: Invoke) {
    if (hasAccess()) openTree(invoke)
    else askAccess(invoke, "accessResult", "storagePermissionResult")
  }

  private fun askAccess(invoke: Invoke, activityCallback: String, permissionCallback: String) {
    if (Build.VERSION.SDK_INT >= 30) {
      try {
        startActivityForResult(invoke, Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:${activity.packageName}")), activityCallback)
      } catch (_: Exception) {
        try {
          startActivityForResult(invoke, Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION), activityCallback)
        } catch (_: Exception) {
          invoke.reject("모든 파일 접근 권한 설정 화면을 열지 못했습니다. Android 설정에서 직접 허용해 주세요.")
        }
      }
    } else {
      requestPermissionForAlias("storage", invoke, permissionCallback)
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

  // 사진 선택기는 일부 기기 폴더를 보여 주지 않으므로 모든 폴더를 찾을 수 있는 파일 선택 화면으로 이미지를 고른다.
  @Command
  fun pickImage(invoke: Invoke) {
    val types = invoke.getArgs().optJSONArray("mimeTypes")
    val mimeTypes = Array(types?.length() ?: 0) { types!!.getString(it) }
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "image/*"
      if (mimeTypes.isNotEmpty()) putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes)
    }
    try {
      startActivityForResult(invoke, intent, "imageResult")
    } catch (_: Exception) {
      invoke.reject("파일 선택 화면을 열지 못했습니다.")
    }
  }

  @ActivityCallback
  fun imageResult(invoke: Invoke, result: ActivityResult) {
    val uri = result.data?.data
    if (result.resultCode != Activity.RESULT_OK || uri == null) {
      invoke.resolve(JSObject().apply { put("data", null) })
      return
    }
    Thread {
      try {
        val resolver = activity.contentResolver
        var name = "image"
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
          if (cursor.moveToFirst() && !cursor.isNull(0)) name = cursor.getString(0)
        }
        val output = ByteArrayOutputStream()
        val input = resolver.openInputStream(uri) ?: throw IllegalStateException()
        input.use {
          val buffer = ByteArray(64 * 1024)
          while (true) {
            val read = it.read(buffer)
            if (read < 0) break
            output.write(buffer, 0, read)
            if (output.size() > IMAGE_LIMIT) {
              invoke.reject("이미지는 20MB 이하만 넣을 수 있습니다.")
              return@Thread
            }
          }
        }
        invoke.resolve(JSObject().apply {
          put("name", name)
          put("data", Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP))
        })
      } catch (_: Exception) {
        invoke.reject("선택한 이미지를 읽지 못했습니다.")
      }
    }.start()
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

  private companion object {
    const val IMAGE_LIMIT = 20_000_000
  }
}
