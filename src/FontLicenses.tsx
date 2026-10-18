import ridiLicense from "./fonts/RIDIBatang-OFL.txt?raw";
import pretendardLicense from "./fonts/Pretendard-OFL.txt?raw";
import notoLicense from "./fonts/NotoSansKR-OFL.txt?raw";

const licenses = [
  { name: "리디바탕 (RIDIBatang)", text: ridiLicense },
  { name: "Pretendard Variable", text: pretendardLicense },
  { name: "본고딕 (Noto Sans KR)", text: notoLicense },
];

export default function FontLicenses() {
  return (
    <details className="font-licenses">
      <summary>내장 글꼴 라이선스</summary>
      <p className="settings-description">
        리디바탕·Pretendard·본고딕은 앱에 포함되어 인터넷 연결이나 별도 설치 없이 사용할 수 있습니다.
        각 글꼴에는 SIL Open Font License 1.1이 적용됩니다.
      </p>
      {licenses.map((license) => (
        <details key={license.name}>
          <summary>{license.name}</summary>
          <pre>{license.text}</pre>
        </details>
      ))}
    </details>
  );
}
