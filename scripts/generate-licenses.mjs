// 앱에 포함되는 npm·Rust 패키지의 이름·버전·라이선스를 모아 설정 화면의 오픈소스 라이선스 목록을 만든다.
// 의존성을 바꾼 뒤 `npm run licenses`로 다시 생성한다.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// "MIT/Apache-2.0"과 "Apache-2.0 OR MIT"처럼 표기만 다른 선택형 라이선스를 한 묶음으로 보이게 맞춘다.
const normalize = (license) => {
  if (!license) return "UNKNOWN";
  const text = license.replace(/\s*\/\s*/g, " OR ").trim();
  if (/[()]|\bAND\b|\bWITH\b/.test(text)) return text;
  return text.split(/\s+OR\s+/).sort().join(" OR ");
};
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const npm = Object.entries(lock.packages)
  .filter(([path, info]) => path.startsWith("node_modules/") && !info.dev && !info.devOptional)
  .map(([path, info]) => ({
    name: path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length),
    version: info.version,
    license: normalize(info.license),
  }));

const metadata = JSON.parse(
  execFileSync(
    "cargo",
    ["metadata", "--format-version", "1", "--locked", "--filter-platform", "x86_64-pc-windows-msvc"],
    { cwd: join(root, "src-tauri"), maxBuffer: 256 * 1024 * 1024, encoding: "utf8" },
  ),
);
const resolved = new Set(metadata.resolve.nodes.map((node) => node.id));
const cargo = metadata.packages
  // 이 저장소의 크레이트는 앱 자체의 MIT 라이선스를 따른다.
  .filter((pkg) => resolved.has(pkg.id) && pkg.source)
  .map((pkg) => ({ name: pkg.name, version: pkg.version, license: normalize(pkg.license) }));

const unique = (list) =>
  [...new Map(list.map((item) => [`${item.name}@${item.version}`, item])).values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
const output = { npm: unique(npm), cargo: unique(cargo) };
writeFileSync(join(root, "src", "third-party-licenses.json"), `${JSON.stringify(output)}\n`);
console.log(`npm ${output.npm.length}개, Rust ${output.cargo.length}개 패키지의 라이선스를 기록했습니다.`);
