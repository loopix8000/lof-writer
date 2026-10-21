package local.lof.writer

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.annotation.Keep
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
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

@Keep
@TauriPlugin
class AndroidUpdaterPlugin(private val activity: Activity) : Plugin(activity) {
  private data class Update(val version: String, val code: Long, val url: String, val sha256: String, val certificate: String)
  private val worker = Executors.newSingleThreadExecutor()
  private val endpoint = "https://github.com/loopix8000/lof-writer/releases/download/android-beta/latest.json"
  private var available: Update? = null
  private val updatesDir get() = File(activity.cacheDir, "updates")
  private val downloaded get() = File(updatesDir, "update.apk")
  private val maxApkBytes = 512L * 1024 * 1024

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
        Regex("[0-9]+\\.[0-9]+\\.[0-9]+(?:-[A-Za-z0-9.-]+)?").matches(version) &&
        Regex("[a-f0-9]{64}").matches(sha256) && Regex("[a-f0-9]{64}").matches(certificate) &&
        url == "https://github.com/loopix8000/lof-writer/releases/download/v$version/Lof.Writer_${version}_arm64.apk") {
        "새 버전 정보가 올바르지 않습니다."
      }
      if (nextCode <= code(installed())) {
        invoke.resolve(JSObject().apply { put("available", false) })
        return@perform
      }
      check(Build.VERSION.SDK_INT >= manifest.getInt("minSdk")) { "이 업데이트는 더 최신 Android 버전이 필요합니다." }
      check(certificates(installed()) == setOf(certificate)) { "업데이트의 서명이 현재 앱과 다릅니다." }
      available = Update(version, nextCode, url, sha256, certificate)
      invoke.resolve(JSObject().apply { put("available", true); put("version", version) })
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
  private fun verify(file: File, update: Update) {
    check(file.isFile && file.length() <= maxApkBytes && hash(file) == update.sha256) { "다운로드한 파일을 확인하지 못했습니다. 다시 다운로드해 주세요." }
    val archive = activity.packageManager.getPackageArchiveInfo(file.absolutePath, signingFlags())
    check(archive != null && archive.packageName == activity.packageName && code(archive) == update.code &&
      archive.versionName == update.version && code(archive) > code(installed()) &&
      certificates(archive) == setOf(update.certificate) && certificates(archive) == certificates(installed())) {
      "다운로드한 앱의 버전 또는 서명이 올바르지 않습니다."
    }
  }

  @Command
  fun download(invoke: Invoke) = perform(invoke) {
    val update = checkNotNull(available) { "먼저 새 버전을 확인해 주세요." }
    if (downloaded.isFile && hash(downloaded) == update.sha256) {
      verify(downloaded, update)
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
      invoke.resolve()
    } finally { conn.disconnect(); partial.delete() }
  }

  @Command
  fun install(invoke: Invoke) = perform(invoke) {
    val update = checkNotNull(available) { "먼저 새 버전을 확인해 주세요." }
    verify(downloaded, update)
    activity.runOnUiThread {
      try {
        if (Build.VERSION.SDK_INT >= 26 && !activity.packageManager.canRequestPackageInstalls()) {
          activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
          invoke.reject("이 앱의 설치를 허용한 뒤 돌아와서 다운로드·설치를 다시 눌러 주세요.")
        } else {
          val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.updater", downloaded)
          activity.startActivity(Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            clipData = ClipData.newRawUri("Lof Writer update", uri)
          })
          invoke.resolve()
        }
      } catch (_: Exception) { invoke.reject("Android 설치 화면을 열지 못했습니다.") }
    }
  }
}
