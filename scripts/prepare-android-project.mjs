import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const androidConfig = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.android.conf.json"), "utf8"));

export function prepareAndroidProject() {
  const generated = path.join(root, "src-tauri/gen/android");
  if (!fs.existsSync(path.join(generated, "settings.gradle"))) {
    throw new Error("먼저 npm run tauri -- android init --ci를 실행하세요.");
  }
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(androidConfig.version) ||
      !Number.isSafeInteger(androidConfig.bundle?.android?.versionCode) ||
      androidConfig.bundle.android.versionCode < 1) {
    throw new Error("Android 버전과 versionCode를 확인하세요.");
  }
  fs.cpSync(path.join(root, "src-tauri/android"), generated, { recursive: true });
  fs.writeFileSync(path.join(generated, "app/tauri.properties"),
    `tauri.android.versionName=${androidConfig.version}\ntauri.android.versionCode=${androidConfig.bundle.android.versionCode}\n`);
}
