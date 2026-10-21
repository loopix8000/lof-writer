package local.lof.writer

import android.app.Activity
import android.util.Log
import androidx.annotation.Keep
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.mlkit.common.MlKitException
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning

// Google Play 서비스의 코드 스캐너 화면으로 QR 코드를 읽는다. 앱에는 카메라 권한이 필요하지 않다.
@Keep
@TauriPlugin
class AndroidScannerPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun scanQr(invoke: Invoke) {
    try {
      val options = GmsBarcodeScannerOptions.Builder()
        .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
        .build()
      GmsBarcodeScanning.getClient(activity, options)
        .startScan()
        .addOnSuccessListener { barcode -> invoke.resolve(JSObject().apply { put("text", barcode.rawValue) }) }
        .addOnCanceledListener { invoke.resolve(JSObject().apply { put("text", null) }) }
        .addOnFailureListener { error ->
          if (error is MlKitException && error.errorCode == MlKitException.CODE_SCANNER_CANCELLED) {
            invoke.resolve(JSObject().apply { put("text", null) })
          } else {
            rejectScan(invoke, error)
          }
        }
    } catch (error: RuntimeException) {
      rejectScan(invoke, error)
    }
  }

  private fun rejectScan(invoke: Invoke, error: Exception) {
    Log.e("AndroidScannerPlugin", "QR 스캐너 실행 실패", error)
    invoke.reject("QR 코드 스캐너를 열지 못했습니다. 다시 시도하거나 페어링 코드를 붙여넣어 주세요.")
  }
}
