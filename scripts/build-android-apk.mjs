import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { androidConfig, prepareAndroidProject } from "./prepare-android-project.mjs";

const rootDir = process.cwd();
const isRelease = process.argv.includes("--release");
const runOnly = process.argv.includes("--run-only");
const shouldRun = runOnly || process.argv.includes("--run");
const coldBoot =
  process.argv.includes("--cold-boot") ||
  process.argv.includes("--no-snapshot-load");
const targetArg =
  process.argv.find((arg) => arg.startsWith("--target="))?.split("=")[1] ||
  (shouldRun ? "x86_64" : "aarch64");

const targetMap = {
  aarch64: {
    triple: "aarch64-linux-android",
    abi: "arm64-v8a",
    gradleFlavor: "Arm64",
    clangPrefix: "aarch64-linux-android24",
    envUpper: "AARCH64_LINUX_ANDROID",
    envLower: "aarch64_linux_android",
  },
  x86_64: {
    triple: "x86_64-linux-android",
    abi: "x86_64",
    gradleFlavor: "X86_64",
    clangPrefix: "x86_64-linux-android24",
    envUpper: "X86_64_LINUX_ANDROID",
    envLower: "x86_64_linux_android",
  },
  armv7: {
    triple: "armv7-linux-androideabi",
    abi: "armeabi-v7a",
    gradleFlavor: "Arm",
    clangPrefix: "armv7a-linux-androideabi24",
    envUpper: "ARMV7_LINUX_ANDROIDEABI",
    envLower: "armv7_linux_androideabi",
  },
  i686: {
    triple: "i686-linux-android",
    abi: "x86",
    gradleFlavor: "X86",
    clangPrefix: "i686-linux-android24",
    envUpper: "I686_LINUX_ANDROID",
    envLower: "i686_linux_android",
  },
};

const targetInfo = targetMap[targetArg];
if (!targetInfo) throw new Error(`지원하지 않는 Android 대상: ${targetArg}`);
const profileDir = isRelease ? "release" : "debug";
const gradleVariant = `${targetInfo.gradleFlavor}${isRelease ? "Release" : "Debug"}`;

const androidHome = process.env.ANDROID_HOME || "C:\\Android\\Sdk";
const ndkHome =
  process.env.NDK_HOME || path.join(androidHome, "ndk", "30.0.16248370");
const llvmBin = path.join(
  ndkHome,
  "toolchains",
  "llvm",
  "prebuilt",
  "windows-x86_64",
  "bin",
);
const clangCmd = path.join(llvmBin, `${targetInfo.clangPrefix}-clang.cmd`);
const clangxxCmd = path.join(llvmBin, `${targetInfo.clangPrefix}-clang++.cmd`);
const arExe = path.join(llvmBin, "llvm-ar.exe");
const ranlibExe = path.join(llvmBin, "llvm-ranlib.exe");
const androidDir = path.join(rootDir, "src-tauri", "gen", "android");
const kotlinGeneratedDir = path.join(
  androidDir,
  "app",
  "src",
  "main",
  "java",
  "local",
  "lof",
  "writer",
  "generated",
);

const buildEnv = {
  ...process.env,
  ANDROID_HOME: androidHome,
  NDK_HOME: ndkHome,
  TAURI_ANDROID_PROJECT_PATH: androidDir,
  WRY_ANDROID_KOTLIN_FILES_OUT_DIR: kotlinGeneratedDir,
  TAURI_ENV_TARGET_TRIPLE: targetInfo.triple,
  TAURI_CONFIG: JSON.stringify(androidConfig),
  WRY_ANDROID_PACKAGE: "local.lof.writer",
  WRY_ANDROID_LIBRARY: "lof_writer_lib",
  [`CARGO_TARGET_${targetInfo.envUpper}_LINKER`]: clangCmd,
  [`CC_${targetInfo.envLower}`]: clangCmd,
  [`CXX_${targetInfo.envLower}`]: clangxxCmd,
  [`AR_${targetInfo.envLower}`]: arExe,
  [`RANLIB_${targetInfo.envLower}`]: ranlibExe,
};

function resolveWinCmd(cmd, args) {
  if (process.platform !== "win32") {
    return { file: cmd, args };
  }
  if (/\.(exe)$/i.test(cmd)) {
    return { file: cmd, args };
  }
  const comspec = process.env.ComSpec || "cmd.exe";
  const quotedArgs = [cmd, ...args]
    .map((a) => (/\s|["&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(" ");
  return { file: comspec, args: ["/d", "/s", "/c", quotedArgs] };
}

function run(cmd, args, cwd = rootDir, env = buildEnv) {
  const resolved = resolveWinCmd(cmd, args);
  const res = spawnSync(resolved.file, resolved.args, {
    cwd,
    env,
    stdio: "inherit",
    shell: false,
  });
  return res.status ?? 1;
}

function runCapture(cmd, args) {
  const resolved = resolveWinCmd(cmd, args);
  const res = spawnSync(resolved.file, resolved.args, {
    cwd: rootDir,
    env: buildEnv,
    encoding: "utf8",
    shell: false,
  });
  return (res.stdout || "").trim();
}

const flavorLower = targetInfo.gradleFlavor.toLowerCase();
const apkPath = path.join(
  androidDir,
  "app",
  "build",
  "outputs",
  "apk",
  flavorLower,
  profileDir,
  `app-${flavorLower}-${profileDir}${isRelease ? "-unsigned" : ""}.apk`,
);

if (!runOnly || !fs.existsSync(apkPath)) {
  prepareAndroidProject();
  fs.mkdirSync(kotlinGeneratedDir, { recursive: true });
  // 1. Build frontend
  console.log("[1/3] 프론트엔드 빌드 중...");
  if (run("npm", ["run", "build"]) !== 0) {
    process.exit(1);
  }

  // 2. Build Rust Android shared library directly (avoids Windows symlink permission error)
  console.log(`[2/3] Rust Android 라이브러리 빌드 중 (${targetInfo.triple})...`);
  const cargoArgs = [
    "build",
    "--locked",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--target",
    targetInfo.triple,
    "--features",
    "tauri/custom-protocol",
  ];
  if (isRelease) {
    cargoArgs.push("--release");
  }
  if (run("cargo", cargoArgs) !== 0) {
    process.exit(1);
  }

  const builtSo = path.join(
    rootDir,
    "src-tauri",
    "target",
    targetInfo.triple,
    profileDir,
    "liblof_writer_lib.so",
  );
  const jniDestDir = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "jniLibs",
    targetInfo.abi,
  );
  fs.mkdirSync(jniDestDir, { recursive: true });
  fs.copyFileSync(builtSo, path.join(jniDestDir, "liblof_writer_lib.so"));

  // 3. Assemble APK via Gradle
  console.log(`[3/3] Gradle APK 패키징 중 (assemble${gradleVariant})...`);
  const gradlew = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
  if (run(gradlew, ["--no-daemon", `assemble${gradleVariant}`], androidDir) !== 0) {
    process.exit(1);
  }

  console.log(`\nAPK 생성 완료: ${apkPath}`);
}

if (shouldRun) {
  const adbExe = path.join(androidHome, "platform-tools", "adb.exe");
  const emulatorExe = path.join(androidHome, "emulator", "emulator.exe");

  const getConnectedDevices = () => {
    const out = runCapture(adbExe, ["devices"]);
    return out
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l && /\bdevice$/.test(l));
  };

  const launchedEmulator = getConnectedDevices().length === 0;
  if (launchedEmulator) {
    const avds = runCapture(emulatorExe, ["-list-avds"])
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const avdName = avds[0] || "Lof_Android_16";
    const emulatorArgs = ["-avd", avdName];
    if (coldBoot) {
      emulatorArgs.push("-no-snapshot-load");
    }
    console.log(
      `\n안드로이드 에뮬레이터(${avdName})를 실행합니다${coldBoot ? " (클린 부팅)" : ""}...`,
    );
    const child = spawn(emulatorExe, emulatorArgs, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  }

  console.log("에뮬레이터 부팅 대기 중...");
  run(adbExe, ["wait-for-device"]);
  for (let i = 0; i < 120; i++) {
    const boot = runCapture(adbExe, ["shell", "getprop", "sys.boot_completed"]);
    const anim = runCapture(adbExe, ["shell", "getprop", "init.svc.bootanim"]);
    const pmReady = runCapture(adbExe, ["shell", "pm", "path", "android"]);
    if (boot === "1" && anim === "stopped" && pmReady.includes("package:")) {
      break;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }

  if (launchedEmulator) {
    runCapture(adbExe, ["shell", "wm", "dismiss-keyguard"]);
  }

  console.log("APK 설치 및 앱 실행 중...");
  if (run(adbExe, ["install", "-r", apkPath]) !== 0) {
    process.exit(1);
  }
  run(adbExe, ["shell", "am", "force-stop", "local.lof.writer"]);
  run(adbExe, [
    "shell",
    "am",
    "start",
    "-W",
    "-n",
    "local.lof.writer/.MainActivity",
  ]);
}
