import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { androidConfig } from "./prepare-android-project.mjs";

const root = process.cwd();
for (const name of ["ANDROID_HOME", "ANDROID_KEY_BASE64", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD"]) {
  if (!process.env[name]) throw new Error(`${name} 설정이 필요합니다.`);
}
const tools = path.join(process.env.ANDROID_HOME, "build-tools", "36.0.0");
const executable = name => path.join(tools, `${name}${process.platform === "win32" ? ".exe" : ""}`);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lof-android-sign-"));
const unsigned = path.join(root, "src-tauri/gen/android/app/build/outputs/apk/arm64/release/app-arm64-release-unsigned.apk");
const output = path.join(root, "release");
const assetName = `Lof.Writer_${androidConfig.version}_arm64.apk`;
const signed = path.join(output, assetName);
const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java") : "java";
const keytool = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "keytool.exe" : "keytool") : "keytool";

// 서명 도구의 출력에는 자격 증명이 포함될 수 있으므로 오류에도 원문을 출력하지 않는다.
function quiet(file, args) {
  const result = spawnSync(file, args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`${path.basename(file)} 실행에 실패했습니다. 도구 출력은 숨겼습니다.`);
  return result.stdout;
}
const apksigner = args => quiet(java, ["-jar", path.join(tools, "lib/apksigner.jar"), ...args]);

try {
  const keystore = path.join(temporary, "release.jks");
  fs.writeFileSync(keystore, Buffer.from(process.env.ANDROID_KEY_BASE64, "base64"), { mode: 0o600 });
  const certificate = quiet(keytool, ["-exportcert", "-rfc", "-keystore", keystore,
    "-alias", process.env.ANDROID_KEY_ALIAS, "-storepass:env", "ANDROID_KEY_PASSWORD"]);
  const expectedCertificate = new X509Certificate(certificate).fingerprint256.replaceAll(":", "").toLowerCase();
  const aligned = path.join(temporary, "aligned.apk");
  quiet(executable("zipalign"), ["-P", "16", "-f", "4", unsigned, aligned]);
  fs.mkdirSync(output, { recursive: true });
  apksigner(["sign", "--ks", keystore, "--ks-key-alias", process.env.ANDROID_KEY_ALIAS,
    "--ks-pass", "env:ANDROID_KEY_PASSWORD", "--key-pass", "env:ANDROID_KEY_PASSWORD", "--out", signed, aligned]);
  const signatureInfo = apksigner(["verify", "--verbose", "--print-certs", signed]);
  const certificateSha256 = signatureInfo.match(/Signer #1 certificate SHA-256 digest:\s*([a-f0-9]+)/i)?.[1]?.toLowerCase();
  if (certificateSha256 !== expectedCertificate) throw new Error("APK의 서명 인증서가 키스토어와 다릅니다.");
  quiet(executable("zipalign"), ["-c", "-P", "16", "4", signed]);
  const metadata = quiet(executable("aapt"), ["dump", "badging", signed]);
  const pkg = metadata.match(/^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/m);
  if (!pkg || pkg[1] !== "local.lof.writer" || Number(pkg[2]) !== androidConfig.bundle.android.versionCode ||
      pkg[3] !== androidConfig.version || /^application-debuggable/m.test(metadata) ||
      !/^native-code: 'arm64-v8a'\s*$/m.test(metadata)) {
    throw new Error("배포 APK의 버전·패키지·ABI 또는 디버그 설정이 올바르지 않습니다.");
  }
  const sha256 = createHash("sha256").update(fs.readFileSync(signed)).digest("hex");
  fs.writeFileSync(`${signed}.sha256`, `${sha256}  ${assetName}\n`);
  const repo = process.env.GITHUB_REPOSITORY || "loopix8000/lof-writer";
  const manifest = {
    version: androidConfig.version, versionCode: androidConfig.bundle.android.versionCode,
    platform: "android", arch: "aarch64", minSdk: 24,
    url: `https://github.com/${repo}/releases/download/v${androidConfig.version}/${assetName}`,
    sha256, certificateSha256, pub_date: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(output, "android-latest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`서명과 버전 검증 완료: ${assetName}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${androidConfig.version}\nasset=${assetName}\n`);
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
