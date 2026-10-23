package local.lof.writer

import android.app.Activity
import androidx.annotation.Keep
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@Keep
@TauriPlugin
class AndroidBiometricPlugin(private val activity: Activity) : Plugin(activity) {
  private var pending: Invoke? = null
  private var prompt: BiometricPrompt? = null
  private var cancelling = false

  private fun availability() = BiometricManager.from(activity)
    .canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)

  private fun reason(code: Int): String = when (code) {
    BiometricManager.BIOMETRIC_SUCCESS -> ""
    BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> "기기 설정에서 지문을 먼저 등록해 주세요."
    BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> "지금은 지문을 사용할 수 없습니다. 잠시 후 다시 시도해 주세요."
    else -> "이 기기에서 사용할 수 있는 생체 인증이 없습니다."
  }

  @Command
  fun status(invoke: Invoke) {
    val code = availability()
    invoke.resolve(JSObject().apply {
      put("available", code == BiometricManager.BIOMETRIC_SUCCESS)
      put("reason", reason(code))
    })
  }

  @Command
  fun authenticate(invoke: Invoke) {
    activity.runOnUiThread {
      val host = activity as? FragmentActivity
      if (host == null || !host.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
        invoke.reject("앱을 연 상태에서 다시 인증해 주세요.")
        return@runOnUiThread
      }
      if (pending != null) {
        invoke.reject("지문 인증이 진행 중입니다.")
        return@runOnUiThread
      }
      val code = availability()
      if (code != BiometricManager.BIOMETRIC_SUCCESS) {
        invoke.reject(reason(code))
        return@runOnUiThread
      }
      pending = invoke
      cancelling = false
      try {
        prompt = BiometricPrompt(host, ContextCompat.getMainExecutor(activity),
          object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
              if (pending !== invoke) return
              pending = null
              val authenticated = !cancelling && host.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
              invoke.resolve(JSObject().apply { put("authenticated", authenticated) })
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
              if (pending !== invoke) return
              pending = null
              if (cancelling || errorCode == BiometricPrompt.ERROR_USER_CANCELED ||
                  errorCode == BiometricPrompt.ERROR_CANCELED ||
                  errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON) {
                invoke.resolve(JSObject().apply { put("authenticated", false) })
              } else {
                invoke.reject(errString.toString())
              }
            }
          })
        val info = BiometricPrompt.PromptInfo.Builder()
          .setTitle("Lof Writer 잠금 해제")
          .setSubtitle("기기에 등록된 지문으로 인증해 주세요.")
          .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
          .setNegativeButtonText("PIN 입력")
          .build()
        prompt?.authenticate(info)
      } catch (error: RuntimeException) {
        pending = null
        invoke.reject("지문 인증을 시작하지 못했습니다. PIN을 사용해 주세요.")
      }
    }
  }

  override fun onStop(activity: AppCompatActivity) {
    if (pending == null) return
    // 취소의 최종 콜백을 받기 전에는 다음 요청을 열지 않는다.
    // 이전 인증 결과가 새 요청의 콜백으로 전달되는 것을 막는다.
    cancelling = true
    prompt?.cancelAuthentication()
  }

  override fun onDestroy(activity: AppCompatActivity) {
    val invoke = pending
    pending = null
    cancelling = true
    prompt?.cancelAuthentication()
    prompt = null
    invoke?.resolve(JSObject().apply { put("authenticated", false) })
  }
}
