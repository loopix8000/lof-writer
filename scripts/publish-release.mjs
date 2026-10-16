import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const repo = process.env.GITHUB_REPOSITORY;
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("GITHUB_REPOSITORY is required.");
const tag = `v${version}`;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lof-release-"));

function gh(...args) {
  return execFileSync("gh", [...args, "--repo", repo], {
    cwd: root, encoding: "utf8", windowsHide: true,
  }).trim();
}

try {
  const release = JSON.parse(gh("release", "view", tag, "--json", "assets,isDraft,isPrerelease,targetCommitish"));
  if (release.isPrerelease !== version.includes("-")) throw new Error("Release channel does not match the version.");
  gh("release", "download", tag, "--pattern", "latest.json", "--dir", temporary);
  const manifestPath = path.join(temporary, "latest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.version.replace(/^v/, "") !== version) throw new Error("Updater version mismatch.");
  const platform = manifest.platforms?.["windows-x86_64-msi"] ?? manifest.platforms?.["windows-x86_64"];
  if (!platform?.signature) throw new Error("Signed Windows updater entry is missing.");
  const download = new URL(platform.url);
  const prefix = `/${repo}/releases/download/${tag}/`;
  if (download.origin !== "https://github.com" || !download.pathname.startsWith(prefix)) {
    throw new Error("Updater must point to this version's release assets.");
  }
  const installer = decodeURIComponent(download.pathname.slice(prefix.length));
  if (!installer.endsWith(".msi") || installer.includes("/")) throw new Error("Invalid MSI asset name.");
  for (const name of [installer, `${installer}.sig`]) {
    if (!release.assets.some(asset => asset.name === name && asset.size > 0)) {
      throw new Error(`Missing release asset: ${name}`);
    }
  }
  gh("release", "download", tag, "--pattern", `${installer}.sig`, "--dir", temporary);
  if (fs.readFileSync(path.join(temporary, `${installer}.sig`), "utf8").trim() !== platform.signature.trim()) {
    throw new Error("Updater signature does not match the MSI signature asset.");
  }

  // Publish installers before moving the channel so the manifest always has a public download.
  if (release.isDraft) gh("release", "edit", tag, "--draft=false", "--latest=false");
  if (version.includes("-")) {
    let channel;
    try {
      channel = JSON.parse(gh("release", "view", "beta", "--json", "isDraft,isPrerelease"));
    } catch (error) {
      if (!/release not found|HTTP 404/i.test(String(error.stderr))) throw error;
    }
    if (!channel) {
      gh("release", "create", "beta", "--target", process.env.GITHUB_SHA || release.targetCommitish,
        "--draft", "--prerelease", "--title", "Beta update channel",
        "--notes", "베타 앱의 업데이트 정보를 제공합니다. 설치 파일은 버전별 릴리즈에서 다운로드하세요.");
    } else if (!channel.isPrerelease) {
      throw new Error("The beta channel must be a prerelease.");
    }
    gh("release", "upload", "beta", manifestPath, "--clobber");
    gh("release", "edit", "beta", "--draft=false", "--prerelease", "--latest=false");
  } else {
    gh("release", "edit", tag, "--latest");
  }
  console.log(`Published ${tag}${version.includes("-") ? " and updated the beta channel" : ""}.`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
