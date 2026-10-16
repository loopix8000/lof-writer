import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicKey = process.env.TAURI_UPDATER_PUBLIC_KEY?.trim();
const endpoint = process.env.TAURI_UPDATER_ENDPOINT?.trim();
if (!publicKey || !endpoint) {
  throw new Error("TAURI_UPDATER_PUBLIC_KEY와 TAURI_UPDATER_ENDPOINT를 설정하세요.");
}
const parsedEndpoint = new URL(endpoint);
if (parsedEndpoint.protocol !== "https:" || parsedEndpoint.username || parsedEndpoint.password) {
  throw new Error("업데이트 주소는 인증 정보가 없는 HTTPS URL이어야 합니다.");
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const config = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
const cargo = fs.readFileSync(path.join(root, "src-tauri/Cargo.toml"), "utf8");
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (pkg.version !== config.version || pkg.version !== cargoVersion) {
  throw new Error("package.json, tauri.conf.json, Cargo.toml의 버전을 일치시키세요.");
}
const outputPath = path.join(root, "src-tauri/tauri.updater.generated.json");
fs.writeFileSync(outputPath, JSON.stringify({
  bundle: { createUpdaterArtifacts: true },
  plugins: {
    updater: { pubkey: publicKey, endpoints: [endpoint], windows: { installMode: "passive" } },
  },
}, null, 2) + "\n");
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT,
    `version=${pkg.version}\nprerelease=${pkg.version.includes("-")}\n`);
}
console.log("서명된 MSI 빌드를 위한 업데이트 설정을 준비했습니다.");
