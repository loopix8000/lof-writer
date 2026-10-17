import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
const version = pkg.version;
const mode = process.argv[2] || "dir";

// 앱 버전이나 저장소 위치가 바뀌어도 기존 폴더 배포본의 위치를 유지한다.
const releaseDir = "C:\\Projects\\lof-writer\\release";
const unpackedDir = path.join(releaseDir, "win-unpacked");
const builtExe = path.join(
  rootDir,
  "src-tauri",
  "target",
  "release",
  process.platform === "win32" ? "lof-writer.exe" : "lof-writer",
);
const iconPath = path.join(rootDir, "assets", "icon.ico");

function assertChildPath(parent, target) {
  const base = fs.realpathSync(parent);
  const resolved = fs.realpathSync(target);
  const relative = path.relative(base, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove a path outside ${base}: ${resolved}`);
  }
}

// Only force Cargo to re-run build.rs when icon.ico changed since the last build
const cargoBuildDir = path.join(rootDir, "src-tauri", "target", "release", "build");
const iconChanged =
  fs.existsSync(iconPath) &&
  (!fs.existsSync(builtExe) ||
    fs.statSync(iconPath).mtimeMs > fs.statSync(builtExe).mtimeMs);
if (iconChanged && fs.existsSync(cargoBuildDir)) {
  for (const entry of fs.readdirSync(cargoBuildDir)) {
    if (entry.startsWith("lof-writer-")) {
      assertChildPath(cargoBuildDir, path.join(cargoBuildDir, entry));
      fs.rmSync(path.join(cargoBuildDir, entry), { recursive: true, force: true });
    }
  }
}

const tauriCli = path.join(rootDir, "node_modules", "@tauri-apps", "cli", "tauri.js");
const tauriArgs =
  mode === "msi"
    ? [tauriCli, "build", "--bundles", "msi"]
    : [tauriCli, "build", "--no-bundle"];

const result = spawnSync(process.execPath, tauriArgs, {
  cwd: rootDir,
  stdio: "inherit",
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

if (!fs.existsSync(builtExe)) {
  console.error(`Built executable not found at: ${builtExe}`);
  process.exit(1);
}

if (process.platform === "win32") {
  spawnSync("taskkill", ["/F", "/IM", "Lof Writer.exe"], { stdio: "ignore" });
}

fs.mkdirSync(unpackedDir, { recursive: true });
assertChildPath(releaseDir, unpackedDir);
for (const entry of fs.readdirSync(unpackedDir)) {
  assertChildPath(unpackedDir, path.join(unpackedDir, entry));
}
for (const entry of fs.readdirSync(unpackedDir)) {
  fs.rmSync(path.join(unpackedDir, entry), {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
}

const targetExeName = process.platform === "win32" ? "Lof Writer.exe" : "Lof Writer";
const targetExePath = path.join(unpackedDir, targetExeName);
fs.copyFileSync(builtExe, targetExePath);

if (fs.existsSync(iconPath)) {
  fs.copyFileSync(iconPath, path.join(unpackedDir, "icon.ico"));
  // Also place icon.ico in resources/icon.ico so any Windows Taskbar / JumpList
  // entry cached under local.lof.writer resolves the icon file immediately.
  const resourcesDir = path.join(unpackedDir, "resources");
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.copyFileSync(iconPath, path.join(resourcesDir, "icon.ico"));
}

if (mode === "msi") {
  const msiBundleDir = path.join(
    rootDir,
    "src-tauri",
    "target",
    "release",
    "bundle",
    "msi",
  );
  if (fs.existsSync(msiBundleDir)) {
    for (const file of fs.readdirSync(msiBundleDir)) {
      if (file.endsWith(".msi")) {
        fs.copyFileSync(
          path.join(msiBundleDir, file),
          path.join(releaseDir, file),
        );
      }
    }
  }
}

if (process.platform === "win32" && iconChanged) {
  const appData = process.env.APPDATA;
  if (appData) {
    const implicitDir = path.join(
      appData,
      "Microsoft",
      "Internet Explorer",
      "Quick Launch",
      "User Pinned",
      "ImplicitAppShortcuts",
    );
    if (fs.existsSync(implicitDir)) {
      for (const sub of fs.readdirSync(implicitDir)) {
        const lnk = path.join(implicitDir, sub, "Lof Writer.lnk");
        if (fs.existsSync(lnk)) {
          try {
            fs.rmSync(lnk, { force: true });
          } catch {
            // Ignore
          }
        }
      }
    }
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const explorerCacheDir = path.join(localAppData, "Microsoft", "Windows", "Explorer");
    if (fs.existsSync(explorerCacheDir)) {
      for (const f of fs.readdirSync(explorerCacheDir)) {
        if (f.startsWith("iconcache_") && f.endsWith(".db")) {
          try {
            fs.rmSync(path.join(explorerCacheDir, f), { force: true });
          } catch {
            // Ignore locked files
          }
        }
      }
    }
  }
  spawnSync("ie4uinit.exe", ["-ClearIconCache"], { stdio: "ignore", timeout: 3000 });
  spawnSync("ie4uinit.exe", ["-show"], { stdio: "ignore", timeout: 3000 });
}

console.log(`Packaged Lof Writer ${version} -> ${unpackedDir}`);

