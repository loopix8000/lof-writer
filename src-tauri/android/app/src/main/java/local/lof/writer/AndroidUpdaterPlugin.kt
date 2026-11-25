package local.lof.writer

import android.Manifest
import android.app.Activity
import android.app.DownloadManager
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.widget.Toast
import androidx.annotation.Keep
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject
import java.io.File
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection

@InvokeArg
class UpdateArgs {
  var channel: String = "stable"
  var version: String = ""
}

@Keep
@TauriPlugin(
  permissions = [Permission(strings = [Manifest.permission.WRITE_EXTERNAL_STORAGE], alias = "downloads")]
)
class AndroidUpdaterPlugin(private val activity: Activity) : Plugin(activity) {
  private data class Update(val version: String, val code: Long, val url: String, val sha256: String, val certificate: String, val channel: String)
  private val worker = Executors.newSingleThreadExecutor()
  private var available: Update? = null
  private val updatesDir get() = File(activity.cacheDir, "updates")
  private val downloaded get() = File(updatesDir, "update.apk")
  private val preferences = activity.getSharedPreferences("android-updater", Activity.MODE_PRIVATE)
  private val apkMime = "application/vnd.android.package-archive"
  private val maxApkBytes = 512L * 1024 * 1024
  private val versionPattern = Regex("([0-9]+)\\.([0-9]+)\\.([0-9]+)(?:-([A-Za-z0-9.-]+))?")

  private fun compareVersions(left: String, right: String): Int? {
    val a = versionPattern.matchEntire(left) ?: return null
    val b = versionPattern.matchEntire(right) ?: return null
    for (i in 1..3) {
      val result = a.groupValues[i].toBigInteger().compareTo(b.groupValues[i].toBigInteger())
      if (result != 0) return result
    }
    val ap = a.groupValues[4].split('.').filter { it.isNotEmpty() }
    val bp = b.groupValues[4].split('.').filter { it.isNotEmpty() }
    if (ap.isEmpty() || bp.isEmpty()) return if (ap.isEmpty()) if (bp.isEmpty()) 0 else 1 else -1
    for (i in 0 until maxOf(ap.size, bp.size)) {
      val x = ap.getOrNull(i) ?: return -1
      val y = bp.getOrNull(i) ?: return 1
      if (x == y) continue
      val nx = x.all { it.isDigit() }
      val ny = y.all { it.isDigit() }
      if (nx && ny) {
        val result = x.toBigInteger().compareTo(y.toBigInteger())
        if (result != 0) return result
      } else if (nx != ny) return if (nx) -1 else 1
      else return x.compareTo(y)
    }
    return 0
  }

  private fun perform(invoke: Invoke, task: () -> Unit) {
    worker.execute {
      try { task() } catch (error: Exception) {
        invoke.reject(if (error is IllegalStateException) error.message else "업데이트를 처리하지 못했습니다. 네트워크 연결을 확인해 주세요.")
      }
    }
  }

  private fun connection(address: String): HttpsURLConnection {
    var url = URL(address)
    repeat(6) {
      check(url.protocol == "https" && url.host in setOf("github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com")) {
        "업데이트 다운로드 주소가 올바르지 않습니다."
      }
      val conn = url.openConnection() as HttpsURLConnection
      conn.connectTimeout = 15_000
      conn.readTimeout = 30_000
      conn.instanceFollowRedirects = false
      conn.setRequestProperty("User-Agent", "Lof-Writer-Android")
      conn.setRequestProperty("Cache-Control", "no-cache")
      val code = conn.responseCode
      if (code !in setOf(301, 302, 303, 307, 308)) return conn
      val next = conn.getHeaderField("Location")
      conn.disconnect()
      check(!next.isNullOrBlank()) { "업데이트 다운로드 주소를 확인하지 못했습니다." }
      url = URL(url, next)
    }
    error("업데이트 다운로드 주소를 확인하지 못했습니다.")
  }

  @Suppress("DEPRECATION")
  private fun signingFlags() = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES

  @Suppress("DEPRECATION")
  private fun code(info: PackageInfo): Long = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()

  @Suppress("DEPRECATION")
  private fun certificates(info: PackageInfo): Set<String> {
    val signatures = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
    return signatures.orEmpty().map { hex(MessageDigest.getInstance("SHA-256").digest(it.toByteArray())) }.toSet()
  }

  private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }

  @Suppress("DEPRECATION")
  private fun installed() = activity.packageManager.getPackageInfo(activity.packageName, signingFlags())

  private fun hash(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buffer = ByteArray(64 * 1024)
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        digest.update(buffer, 0, count)
      }
    }
    return hex(digest.digest())
  }

  @Command
  fun check(invoke: Invoke) = perform(invoke) {
    available = null
    val channel = invoke.parseArgs(UpdateArgs::class.java).channel
    check(channel in setOf("stable", "rc", "beta")) { "업데이트 채널을 확인해 주세요." }
    val endpoint = "https://github.com/loopix8000/lof-writer/releases/download/android-$channel/latest.json"
    val conn = connection(endpoint)
    try {
      if (conn.responseCode == 404) {
        invoke.resolve(JSObject().apply { put("available", false) })
        return@perform
      }
      check(conn.responseCode == 200) { "새 버전 정보를 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요." }
      val bytes = conn.inputStream.use { it.readBytesLimited(64 * 1024) }
      val manifest = JSONObject(String(bytes, Charsets.UTF_8))
      val version = manifest.getString("version")
      val nextCode = manifest.getLong("versionCode")
      val sha256 = manifest.getString("sha256").lowercase()
      val certificate = manifest.getString("certificateSha256").lowercase()
      val url = manifest.getString("url")
      check(manifest.getString("platform") == "android" && manifest.getString("arch") == "aarch64" &&
        versionPattern.matches(version) &&
        Regex("[a-f0-9]{64}").matches(sha256) && Regex("[a-f0-9]{64}").matches(certificate) &&
        url == "https://github.com/loopix8000/lof-writer/releases/download/v$version/Lof.Writer_${version}_arm64.apk") {
        "새 버전 정보가 올바르지 않습니다."
      }
      val kind = version.substringAfter('-', "").substringBefore('.')
      val allowed = when (channel) {
        "stable" -> kind.isEmpty()
        "rc" -> kind.isEmpty() || kind == "rc"
        else -> true
      }
      val current = installed()
      if (!allowed || nextCode <= code(current) || compareVersions(version, current.versionName.orEmpty())?.let { it <= 0 } == true) {
        invoke.resolve(JSObject().apply { put("available", false) })
        return@perform
      }
      check(Build.VERSION.SDK_INT >= manifest.getInt("minSdk")) { "이 업데이트는 더 최신 Android 버전이 필요합니다." }
      check(certificates(installed()) == setOf(certificate)) { "업데이트의 서명이 현재 앱과 다릅니다." }
      available = Update(version, nextCode, url, sha256, certificate, channel)
      invoke.resolve(JSObject().apply {
        put("available", true)
        put("version", version)
        put("downloaded", hasSavedDownload(available!!))
      })
    } finally { conn.disconnect() }
  }

  private fun java.io.InputStream.readBytesLimited(limit: Int): ByteArray {
    val output = java.io.ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    while (true) {
      val count = read(buffer)
      if (count < 0) break
      check(output.size() + count <= limit) { "새 버전 정보의 크기가 올바르지 않습니다." }
      output.write(buffer, 0, count)
    }
    return output.toByteArray()
  }

  @Suppress("DEPRECATION")
  private fun verify(file: File, update: Update, hashVerified: Boolean = false) {
    check(file.isFile && file.length() <= maxApkBytes && (hashVerified || hash(file) == update.sha256)) { "다운로드한 파일을 확인하지 못했습니다. 다시 다운로드해 주세요." }
    val archive = activity.packageManager.getPackageArchiveInfo(file.absolutePath, signingFlags())
    check(archive != null && archive.packageName == activity.packageName && code(archive) == update.code &&
      archive.versionName == update.version && code(archive) > code(installed()) &&
      certificates(archive) == setOf(update.certificate) && certificates(archive) == certificates(installed())) {
      "다운로드한 앱의 버전 또는 서명이 올바르지 않습니다."
    }
  }

  @Command
  fun download(invoke: Invoke) {
    if (Build.VERSION.SDK_INT < 29 && ContextCompat.checkSelfPermission(activity,
        Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
      requestPermissionForAlias("downloads", invoke, "downloadPermissionResult")
    } else downloadApk(invoke)
  }

  @PermissionCallback
  fun downloadPermissionResult(invoke: Invoke) {
    if (ContextCompat.checkSelfPermission(activity, Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED) {
      downloadApk(invoke)
    } else invoke.reject("APK를 다운로드 폴더에 저장하려면 저장소 접근을 허용해 주세요.")
  }

  private fun downloadApk(invoke: Invoke) = perform(invoke) {
    val update = checkNotNull(available) { "먼저 새 버전을 확인해 주세요." }
    val args = invoke.parseArgs(UpdateArgs::class.java)
    check(update.version == args.version && update.channel == args.channel) { "업데이트 채널이 변경되었습니다. 다시 확인해 주세요." }
    if (hasSavedDownload(update)) {
      invoke.resolve()
      return@perform
    }
    if (downloaded.isFile && hash(downloaded) == update.sha256) {
      verify(downloaded, update, hashVerified = true)
      saveToDownloads(update)
      invoke.resolve()
      return@perform
    }
    check(updatesDir.isDirectory || updatesDir.mkdirs()) { "업데이트를 저장할 공간을 준비하지 못했습니다." }
    val partial = File(updatesDir, "update.partial.apk")
    val conn = connection(update.url)
    try {
      check(conn.responseCode == 200 && conn.contentLengthLong <= maxApkBytes) { "업데이트 파일을 다운로드하지 못했습니다." }
      conn.inputStream.use { input ->
        partial.outputStream().use { output ->
          val buffer = ByteArray(64 * 1024)
          var size = 0L
          while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            size += count
            check(size <= maxApkBytes) { "업데이트 파일 크기가 올바르지 않습니다." }
            output.write(buffer, 0, count)
          }
        }
      }
      verify(partial, update)
      check(!downloaded.exists() || downloaded.delete()) { "이전 업데이트 파일을 정리하지 못했습니다." }
      check(partial.renameTo(downloaded)) { "다운로드한 업데이트를 저장하지 못했습니다." }
      saveToDownloads(update)
      invoke.resolve()
    } finally { conn.disconnect(); partial.delete() }
  }

  private fun hasSavedDownload(update: Update): Boolean {
    if (preferences.getString("sha256", null) != update.sha256) return false
    val uri = preferences.getString("uri", null)?.let(Uri::parse) ?: return false
    return try {
      activity.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use {
        it.moveToFirst() && it.getLong(0) > 0
      } == true
    } catch (_: Exception) { false }
  }

  @Suppress("DEPRECATION")
  private fun saveToDownloads(update: Update) {
    val name = "Lof.Writer_${update.version}_arm64.apk"
    val resolver = activity.contentResolver
    val uri = if (Build.VERSION.SDK_INT >= 29) {
      val entry = checkNotNull(resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, ContentValues().apply {
        put(MediaStore.Downloads.DISPLAY_NAME, name)
        put(MediaStore.Downloads.MIME_TYPE, apkMime)
        put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
        put(MediaStore.Downloads.IS_PENDING, 1)
      })) { "다운로드 폴더에 APK를 저장하지 못했습니다." }
      try {
        checkNotNull(resolver.openOutputStream(entry)) { "다운로드 폴더에 APK를 저장하지 못했습니다." }.use { output ->
          downloaded.inputStream().use { it.copyTo(output) }
        }
        check(resolver.update(entry, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null) == 1) {
          "다운로드한 APK를 공개하지 못했습니다. 다시 시도해 주세요."
        }
        entry
      } catch (error: Exception) {
        runCatching { resolver.delete(entry, null, null) }
        throw error
      }
    } else {
      val directory = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
      check(directory.isDirectory || directory.mkdirs()) { "다운로드 폴더를 준비하지 못했습니다." }
      var file = File(directory, name)
      var suffix = 1
      while (!file.createNewFile()) file = File(directory, "${name.removeSuffix(".apk")} (${suffix++}).apk")
      try {
        downloaded.inputStream().use { input -> file.outputStream().use { input.copyTo(it) } }
        val manager = activity.getSystemService(Activity.DOWNLOAD_SERVICE) as DownloadManager
        val id = manager.addCompletedDownload(file.name, "Lof Writer 업데이트", false, apkMime, file.absolutePath, file.length(), false)
        checkNotNull(manager.getUriForDownloadedFile(id)) { "다운로드한 APK를 등록하지 못했습니다." }
      } catch (error: Exception) {
        file.delete()
        throw error
      }
    }
    preferences.edit().putString("sha256", update.sha256).putString("uri", uri.toString()).apply()
    activity.runOnUiThread {
      Toast.makeText(activity, "다운로드 폴더에 APK를 저장했습니다.", Toast.LENGTH_LONG).show()
    }
  }

  @Command
  fun openDownloads(invoke: Invoke) {
    activity.runOnUiThread {
      try {
        activity.startActivity(Intent(DownloadManager.ACTION_VIEW_DOWNLOADS))
        invoke.resolve()
      } catch (_: Exception) { invoke.reject("다운로드 폴더를 열지 못했습니다. 파일 앱에서 다운로드 폴더를 열어 주세요.") }
    }
  }
}
