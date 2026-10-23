import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publishChannels, releaseChannel } from "./update-channels.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const isAndroid = args.has("--android");
const isDraftOnly = args.has("--draft");
const skipBuild = args.has("--skip-build");
const shouldPush = args.has("--push");
const showUpdateNotice = args.has("--show-update-notice") ? "true" : "false";

function git(...cmdArgs) {
  return execFileSync("git", cmdArgs, {
    cwd: rootDir,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function resolveRepo() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY.trim();
  const remote = git("remote", "get-url", "origin");
  const match = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/i.exec(remote);
  if (!match) throw new Error(`origin 원격 저장소에서 GitHub 저장소 이름을 찾지 못했습니다: ${remote}`);
  return match[1];
}

function ensureTargetCommitOnRemote(target) {
  if (shouldPush) {
    const pushResult = spawnSync("git", ["push", "origin", "HEAD"], {
      cwd: rootDir,
      stdio: "inherit",
      windowsHide: true,
    });
    if (pushResult.status !== 0) process.exit(pushResult.status ?? 1);
  }
  execFileSync("git", ["fetch", "-q", "origin"], { cwd: rootDir, windowsHide: true });
  const remoteBranches = git("branch", "-r", "--contains", target);
  if (!remoteBranches) {
    throw new Error(
      `현재 HEAD 커밋(${target.slice(0, 7)})이 원격 저장소(origin)에 없습니다. 먼저 git push origin main을 실행하거나 --push 옵션을 함께 전달하세요.`,
    );
  }
}

function runNodeScript(scriptRelPath, scriptArgs = [], extraEnv = {}) {
  const scriptPath = path.join(rootDir, scriptRelPath);
  const result = spawnSync(process.execPath, [scriptPath, ...scriptArgs], {
    cwd: rootDir,
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, ...extraEnv },
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function cleanZeroByteCodegenCache() {
  const cargoBuildDir = path.join(rootDir, "src-tauri", "target", "release", "build");
  if (!fs.existsSync(cargoBuildDir)) return;
  for (const entry of fs.readdirSync(cargoBuildDir)) {
    if (!entry.startsWith("lof-writer-")) continue;
    const assetsDir = path.join(cargoBuildDir, entry, "out", "tauri-codegen-assets");
    if (!fs.existsSync(assetsDir)) continue;
    for (const asset of fs.readdirSync(assetsDir, { withFileTypes: true })) {
      if (!asset.isFile()) continue;
      const cachePath = path.join(assetsDir, asset.name);
      if (fs.statSync(cachePath).size === 0) {
        fs.rmSync(cachePath, { force: true });
      }
    }
  }
}

function loadWindowsSigningEnv() {
  const privateDir = path.join(rootDir, ".private");
  const privateKeyPath = path.join(privateDir, "updater.key");
  const publicKeyPath = path.join(privateDir, "updater.key.pub");
  const privateKey =
    process.env.TAURI_SIGNING_PRIVATE_KEY?.trim() ||
    (fs.existsSync(privateKeyPath) ? fs.readFileSync(privateKeyPath, "utf8").trim() : "");
  const publicKey =
    process.env.TAURI_UPDATER_PUBLIC_KEY?.trim() ||
    (fs.existsSync(publicKeyPath) ? fs.readFileSync(publicKeyPath, "utf8").trim() : "");
  if (!privateKey || !publicKey) {
    throw new Error(
      "Windows 릴리즈 서명 키를 찾지 못했습니다. .private/updater.key 및 .private/updater.key.pub 파일이나 환경 변수를 확인하세요.",
    );
  }
  return {
    TAURI_SIGNING_PRIVATE_KEY: privateKey,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
    TAURI_UPDATER_PUBLIC_KEY: publicKey,
    TAURI_UPDATER_ENDPOINT:
      process.env.TAURI_UPDATER_ENDPOINT?.trim() ||
      "https://github.com/loopix8000/lof-writer/releases/download/stable/latest.json",
  };
}

function verifyWindowsMsiSignature({ msiPath, signatureBase64, publicKeyBase64 }) {
  const decode = (value) => Buffer.from(value, "base64").toString("utf8").trim().split(/\r?\n/);
  const publicPacket = Buffer.from(decode(publicKeyBase64)[1] ?? "", "base64");
  const signatureLines = decode(signatureBase64.trim());
  const signaturePacket = Buffer.from(signatureLines[1] ?? "", "base64");
  if (
    publicPacket.length !== 42 ||
    signaturePacket.length !== 74 ||
    signaturePacket.subarray(0, 2).toString() !== "ED" ||
    !signatureLines[2]?.startsWith("trusted comment: ")
  ) {
    throw new Error("업데이트 공개키 또는 서명 형식이 올바르지 않습니다.");
  }
  if (!publicPacket.subarray(2, 10).equals(signaturePacket.subarray(2, 10))) {
    throw new Error("비밀키와 앱 공개키가 다릅니다. 기존 Writer 비밀키를 확인해 주세요.");
  }
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicPacket.subarray(10)]),
    format: "der",
    type: "spki",
  });
  const payload = fs.readFileSync(msiPath);
  const digest = createHash("blake2b512").update(payload).digest();
  const signature = signaturePacket.subarray(10);
  const trusted = Buffer.concat([signature, Buffer.from(signatureLines[2].slice(17))]);
  if (
    !verify(null, digest, key, signature) ||
    !verify(null, trusted, key, Buffer.from(signatureLines[3] ?? "", "base64"))
  ) {
    throw new Error("설치 파일의 업데이트 서명 검증에 실패했습니다.");
  }
}

function loadAndroidSigningEnv() {
  const androidPrivateDir = path.join(rootDir, ".private", "android");
  const signingJsonPath = path.join(androidPrivateDir, "signing.json");
  const jksBase64Path = path.join(androidPrivateDir, "release.jks.base64.txt");
  const jksPath = path.join(androidPrivateDir, "release.jks");
  const signingConfig = fs.existsSync(signingJsonPath)
    ? JSON.parse(fs.readFileSync(signingJsonPath, "utf8"))
    : {};

  let keyBase64 = process.env.ANDROID_KEY_BASE64?.trim() || "";
  if (!keyBase64 && fs.existsSync(jksBase64Path)) {
    keyBase64 = fs.readFileSync(jksBase64Path, "utf8").trim();
  } else if (!keyBase64 && fs.existsSync(jksPath)) {
    keyBase64 = fs.readFileSync(jksPath).toString("base64");
  }

  const keyAlias = process.env.ANDROID_KEY_ALIAS?.trim() || signingConfig.keyAlias || "";
  const keyPassword =
    process.env.ANDROID_KEY_PASSWORD?.trim() ||
    signingConfig.keyPassword ||
    signingConfig.storePassword ||
    "";
  const androidHome = process.env.ANDROID_HOME?.trim() || "C:\\Android\\Sdk";

  if (!keyBase64 || !keyAlias || !keyPassword) {
    throw new Error(
      "Android 서명 키 정보를 찾지 못했습니다. .private/android/signing.json 및 release.jks 파일이나 환경 변수를 확인하세요.",
    );
  }
  return {
    ANDROID_HOME: androidHome,
    ANDROID_KEY_BASE64: keyBase64,
    ANDROID_KEY_ALIAS: keyAlias,
    ANDROID_KEY_PASSWORD: keyPassword,
  };
}

function releaseWindows({ repo, target }) {
  const signingEnv = loadWindowsSigningEnv();
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  const version = pkg.version;
  const tag = `v${version}`;

  runNodeScript("scripts/prepare-updater.mjs", [], signingEnv);

  if (!skipBuild) {
    cleanZeroByteCodegenCache();
    const tauriCli = path.join(rootDir, "node_modules", "@tauri-apps", "cli", "tauri.js");
    const buildResult = spawnSync(
      process.execPath,
      [tauriCli, "build", "--bundles", "msi", "--config", "src-tauri/tauri.updater.generated.json"],
      {
        cwd: rootDir,
        stdio: "inherit",
        windowsHide: true,
        env: {
          ...process.env,
          ...signingEnv,
          VITE_SHOW_UPDATE_NOTICE: showUpdateNotice,
        },
      },
    );
    if (buildResult.status !== 0) {
      process.exit(buildResult.status ?? 1);
    }
  }

  const msiBundleDir = path.join(rootDir, "src-tauri", "target", "release", "bundle", "msi");
  if (!fs.existsSync(msiBundleDir)) {
    throw new Error(`MSI 빌드 결과 폴더가 없습니다: ${msiBundleDir}`);
  }
  const msiCandidates = fs
    .readdirSync(msiBundleDir)
    .filter((name) => name.endsWith(".msi") && name.includes(`_${version}_`))
    .map((name) => ({
      name,
      mtimeMs: fs.statSync(path.join(msiBundleDir, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (msiCandidates.length === 0) {
    throw new Error(`버전 ${version}에 해당하는 MSI 파일을 찾지 못했습니다: ${msiBundleDir}`);
  }

  const builtMsiName = msiCandidates[0].name;
  const builtMsiPath = path.join(msiBundleDir, builtMsiName);
  const builtSigPath = `${builtMsiPath}.sig`;
  if (!fs.existsSync(builtSigPath)) {
    throw new Error(`MSI 서명 파일(.sig)이 없습니다: ${builtSigPath}`);
  }

  const releaseDir = path.join(rootDir, "release");
  fs.mkdirSync(releaseDir, { recursive: true });
  const normalizedMsiName = builtMsiName.replaceAll(" ", ".");
  const stagedMsiPath = path.join(releaseDir, normalizedMsiName);
  const stagedSigPath = `${stagedMsiPath}.sig`;
  fs.copyFileSync(builtMsiPath, stagedMsiPath);
  fs.copyFileSync(builtSigPath, stagedSigPath);

  const signature = fs.readFileSync(stagedSigPath, "utf8").trim();
  // 업로드 전에 로컬에서 Ed25519 서명과 공개키 일치를 바로 검증한다.
  verifyWindowsMsiSignature({
    msiPath: stagedMsiPath,
    signatureBase64: signature,
    publicKeyBase64: signingEnv.TAURI_UPDATER_PUBLIC_KEY,
  });

  const downloadUrl = `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(normalizedMsiName)}`;
  const manifestPath = path.join(releaseDir, "latest.json");
  const manifest = {
    version,
    notes: "Windows MSI 설치 파일과 업데이트 정보를 포함합니다.",
    pub_date: new Date().toISOString(),
    platforms: {
      "windows-x86_64": { signature, url: downloadUrl },
      "windows-x86_64-msi": { signature, url: downloadUrl },
    },
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`서명과 버전 검증 완료: ${normalizedMsiName}`);

  const gh = (...ghArgs) =>
    execFileSync("gh", [...ghArgs, "--repo", repo], {
      cwd: rootDir,
      encoding: "utf8",
      windowsHide: true,
    }).trim();

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lof-win-publish-"));
  try {
    let releaseExists = false;
    try {
      gh("release", "view", tag, "--json", "tagName");
      releaseExists = true;
    } catch {
      releaseExists = false;
    }

    if (!releaseExists) {
      gh(
        "release",
        "create",
        tag,
        stagedMsiPath,
        stagedSigPath,
        manifestPath,
        "--target",
        target,
        "--draft",
        ...(version.includes("-") ? ["--prerelease"] : []),
        "--title",
        `Lof Writer ${tag}`,
        "--notes-file",
        "RELEASE_NOTES.md",
      );
    } else {
      gh("release", "upload", tag, stagedMsiPath, stagedSigPath, manifestPath, "--clobber");
      gh("release", "edit", tag, "--notes-file", "RELEASE_NOTES.md");
    }

    if (isDraftOnly) {
      console.log(`초안(draft) 릴리즈 업로드 완료: ${tag}`);
      return;
    }

    gh("release", "edit", tag, "--draft=false", "--latest=false");
    publishChannels({ repo, version, manifestPath, target, temporary });
    if (releaseChannel(version) === "stable") {
      gh("release", "edit", tag, "--latest");
    }
    console.log(`Published ${tag} and updated release channels.`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function releaseAndroid({ repo, target }) {
  const androidEnv = loadAndroidSigningEnv();

  if (!skipBuild) {
    runNodeScript("scripts/build-android-apk.mjs", ["--release", "--target=aarch64"], {
      ...androidEnv,
      VITE_SHOW_UPDATE_NOTICE: showUpdateNotice,
    });
  }

  runNodeScript("scripts/sign-android-apk.mjs", [], {
    ...androidEnv,
    GITHUB_REPOSITORY: repo,
  });

  if (isDraftOnly) {
    console.log("Android APK 서명 및 매니페스트 생성 완료 (--draft).");
    return;
  }

  runNodeScript("scripts/publish-android-release.mjs", [], {
    ...androidEnv,
    GITHUB_REPOSITORY: repo,
    GITHUB_SHA: target,
  });
}

const repo = resolveRepo();
const target = process.env.GITHUB_SHA?.trim() || git("rev-parse", "HEAD");
ensureTargetCommitOnRemote(target);

if (isAndroid) {
  releaseAndroid({ repo, target });
} else {
  releaseWindows({ repo, target });
}
