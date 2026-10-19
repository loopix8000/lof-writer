import appLicense from "../LICENSE?raw";
import ridiLicense from "./fonts/RIDIBatang-OFL.txt?raw";
import pretendardLicense from "./fonts/Pretendard-OFL.txt?raw";
import notoLicense from "./fonts/NotoSansKR-OFL.txt?raw";
import thirdParty from "./third-party-licenses.json";

type Package = { name: string; version: string; license: string };

const fonts = [
  { name: "리디바탕 (RIDIBatang)", text: ridiLicense },
  { name: "Pretendard Variable", text: pretendardLicense },
  { name: "본고딕 (Noto Sans KR)", text: notoLicense },
];

const libraries = [
  {
    name: "화면 구성 라이브러리 (npm)",
    description: "편집기와 앱 화면을 구성하는 JavaScript 패키지입니다.",
    packages: thirdParty.npm as Package[],
  },
  {
    name: "앱 엔진 라이브러리 (Rust)",
    description: "파일 저장, 동기화, 창 관리 등 앱 내부 기능을 담당하는 Rust 크레이트입니다.",
    packages: thirdParty.cargo as Package[],
  },
];

// 패키지가 많은 라이선스부터 보여 준다.
function byLicense(packages: Package[]) {
  const groups = new Map<string, Package[]>();
  for (const pkg of packages) groups.set(pkg.license, [...(groups.get(pkg.license) ?? []), pkg]);
  return [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

export default function OpenSourceLicenses() {
  return (
    <details className="open-source-licenses">
      <summary>오픈소스 라이선스</summary>
      <p className="settings-description">
        Lof Writer는 오픈소스 소프트웨어이며, 아래 글꼴과 라이브러리를 포함하고 있습니다. 항목을 펼치면 자세한
        내용을 볼 수 있습니다.
      </p>
      <details>
        <summary>
          Lof Writer <span className="license-count">MIT</span>
        </summary>
        <pre>{appLicense}</pre>
      </details>
      <details>
        <summary>
          내장 글꼴 <span className="license-count">{fonts.length}개</span>
        </summary>
        <p className="settings-description">
          리디바탕·Pretendard·본고딕은 앱에 포함되어 인터넷 연결이나 별도 설치 없이 사용할 수 있습니다. 각 글꼴에는
          SIL Open Font License 1.1이 적용됩니다.
        </p>
        {fonts.map((font) => (
          <details key={font.name}>
            <summary>{font.name}</summary>
            <pre>{font.text}</pre>
          </details>
        ))}
      </details>
      {libraries.map((library) => (
        <details key={library.name}>
          <summary>
            {library.name} <span className="license-count">{library.packages.length}개</span>
          </summary>
          <p className="settings-description">{library.description}</p>
          {byLicense(library.packages).map(([license, packages]) => (
            <details key={license}>
              <summary>
                {license} <span className="license-count">{packages.length}개</span>
              </summary>
              <ul className="license-packages">
                {packages.map((pkg) => (
                  <li key={`${pkg.name}@${pkg.version}`}>
                    <span>{pkg.name}</span>
                    <span className="license-version">{pkg.version}</span>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </details>
      ))}
    </details>
  );
}
