import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { androidConfig } from "./prepare-android-project.mjs";
import { publishChannels } from "./update-channels.mjs";

const repo = process.env.GITHUB_REPOSITORY;
const target = process.env.GITHUB_SHA;
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[a-f0-9]{40}$/.test(target ?? "")) {
  throw Error("GITHUB_REPOSITORY and GITHUB_SHA are required.");
}
const version = androidConfig.version;
const tag = `v${version}`;
const asset = `Lof.Writer_${version}_arm64.apk`;
const manifestPath = path.resolve("release/android-latest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.version !== version || manifest.versionCode !== androidConfig.bundle.android.versionCode ||
    manifest.url !== `https://github.com/${repo}/releases/download/${tag}/${asset}`) {
  throw Error("Android release manifest mismatch.");
}
const gh = (...args) => execFileSync("gh", [...args, "--repo", repo], { encoding: "utf8", windowsHide: true }).trim();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lof-android-publish-"));
try {
  gh("release", "create", tag, `release/${asset}`, `release/${asset}.sha256`, manifestPath,
    "--target", target, "--draft", ...(version.includes("-") ? ["--prerelease"] : []),
    "--title", `Lof Writer Android ${tag}`, "--notes-file", "ANDROID_RELEASE_NOTES.md");
  // GitHub Latest는 PC 설치 파일에 사용하고 Android는 플랫폼별 채널을 사용한다.
  gh("release", "edit", tag, "--draft=false", "--latest=false");
  const channelManifest = path.join(temporary, "latest.json");
  fs.copyFileSync(manifestPath, channelManifest);
  publishChannels({ repo, version, manifestPath: channelManifest, target, temporary, android: true });
  console.log(`Published Android ${tag} and updated release channels.`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
