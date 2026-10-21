import java.io.File
import org.apache.tools.ant.taskdefs.condition.Os
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.logging.LogLevel
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.TaskAction
import javax.inject.Inject
import org.gradle.process.ExecOperations

abstract class BuildTask : DefaultTask() {
    @get:Inject
    abstract val execOperations: ExecOperations

    @Input
    var rootDirRel: String? = null
    @Input
    var projectDir: String? = null
    @Input
    var target: String? = null
    @Input
    var release: Boolean? = null

    @TaskAction
    fun assemble() {
        if (Os.isFamily(Os.FAMILY_WINDOWS) && copyBuiltSharedLibIfPresent()) {
            return
        }
        val executable = if (Os.isFamily(Os.FAMILY_WINDOWS)) "npm.cmd" else "npm"
        try {
            runTauriCli(executable)
        } catch (e: Exception) {
            if (Os.isFamily(Os.FAMILY_WINDOWS) && copyBuiltSharedLibIfPresent()) {
                return
            }
            throw e
        }
    }

    private fun copyBuiltSharedLibIfPresent(): Boolean {
        val rootDirRel = rootDirRel ?: return false
        val projectDir = projectDir ?: return false
        val target = target ?: return false
        val release = release ?: false
        val (rustTriple, abiDir) = when (target) {
            "aarch64" -> "aarch64-linux-android" to "arm64-v8a"
            "armv7" -> "armv7-linux-androideabi" to "armeabi-v7a"
            "i686" -> "i686-linux-android" to "x86"
            "x86_64" -> "x86_64-linux-android" to "x86_64"
            else -> return false
        }
        val profileDir = if (release) "release" else "debug"
        val tauriDir = File(projectDir, rootDirRel).canonicalFile
        val builtSo = File(tauriDir, "target/$rustTriple/$profileDir/liblof_writer_lib.so")
        if (!builtSo.exists()) {
            return false
        }
        val destDir = File(projectDir, "src/main/jniLibs/$abiDir")
        destDir.mkdirs()
        val destSo = File(destDir, "liblof_writer_lib.so")
        builtSo.copyTo(destSo, overwrite = true)
        logger.lifecycle("Synced ${builtSo.name} -> jniLibs/$abiDir/${destSo.name}")
        return true
    }

    fun runTauriCli(executable: String) {
        val rootDirRel = rootDirRel ?: throw GradleException("rootDirRel cannot be null")
        val target = target ?: throw GradleException("target cannot be null")
        val release = release ?: throw GradleException("release cannot be null")
        val args = listOf("run", "--", "tauri", "android", "android-studio-script")

        execOperations.exec {
            workingDir(File(projectDir, rootDirRel))
            executable(executable)
            args(args)
            if (logger.isEnabled(LogLevel.DEBUG)) {
                args("-vv")
            } else if (logger.isEnabled(LogLevel.INFO)) {
                args("-v")
            }
            if (release) {
                args("--release")
            }
            args(listOf("--target", target))
        }.assertNormalExitValue()
    }
}
