# 내장 글꼴 및 라이선스

검토일: 2026-10-19

Lof Writer의 소스 코드에는 루트 `LICENSE`의 MIT 라이선스가 적용되지만,
아래 글꼴 파일에는 각 저작권자의 **SIL Open Font License 1.1 (OFL-1.1)**이 별도로 적용됩니다.
공식 배포 원본을 그대로 보관하며, 리디바탕과 본고딕은 로딩 용량을 줄인 WOFF2 압축본을 앱에서 사용합니다.
글꼴 이름·글리프·레이아웃·메타데이터를 보존하고 서브셋은 만들지 않습니다.
PC의 글꼴 설치 상태나 인터넷 연결에 의존하지 않도록 `src/fonts.css`에서 로컬 앱 리소스로 불러옵니다.

| 글꼴 | 포함 파일 | 버전 | 저작권 및 원문 |
| --- | --- | --- | --- |
| 리디바탕 | `src/fonts/RIDIBatang.woff2` (원본: `RIDIBatang.otf`) | 1.0.1 (2019-10-01 빌드) | RIDI & Sandoll. Font designed by Sandoll Inc. [고지 및 OFL 전문](src/fonts/RIDIBatang-OFL.txt) |
| Pretendard Variable | `src/fonts/PretendardVariable.woff2` | 1.3.9 | Copyright (c) 2021, Kil Hyung-jin. Reserved Font Name: Pretendard. [원본 라이선스](src/fonts/Pretendard-OFL.txt) |
| Noto Sans KR | `src/fonts/NotoSansKR-Variable.woff2` (원본: `NotoSansKR-Variable.ttf`) | 2.004-H2 | Copyright 2014-2021 Adobe. Reserved Font Name: Source. [원본 라이선스](src/fonts/NotoSansKR-OFL.txt) |

## 검토 결과 및 준수 조건

- OFL 1.1은 상업용 앱을 포함한 소프트웨어와의 번들·임베딩·재배포를 허용합니다.
- 배포하는 글꼴마다 저작권 고지와 라이선스 전문을 함께 제공해야 합니다. 이 저장소는 글꼴 옆에 원문을 보관하며, 앱의 **설정 → 앱 업데이트 → 오픈소스 라이선스 → 내장 글꼴**에서도 전문을 읽을 수 있도록 빌드에 포함합니다.
- 글꼴 자체를 단독으로 판매할 수 없습니다. 글꼴 파일은 MIT 등 다른 라이선스로 재배포할 수 없으며 OFL 1.1을 유지합니다.
- 수정본은 해당 라이선스의 Reserved Font Name 조건을 준수해야 합니다. 이 저장소의 내장 글꼴은 수정하지 않았습니다.
- 저작권자나 제작자의 이름을 수정본의 홍보·보증에 사용할 수 없습니다.
- 글꼴을 사용해 작성한 원고나 내보낸 문서 자체에 OFL을 적용해야 하는 것은 아닙니다.
- 맑은 고딕·바탕·굴림 등 시스템 글꼴 파일은 앱에 포함하지 않습니다. 시스템 글꼴 선택 시에는 운영체제가 제공하는 글꼴을 사용합니다.

공식 근거: [OFL 1.1 원문](https://openfontlicense.org/open-font-license-official-text/),
[앱에 포함할 때의 공식 안내](https://openfontlicense.org/how-to-use-ofl-fonts/).

## WOFF2 압축

- [OFL FAQ 2.2 및 2.2.1](https://openfontlicense.org/ofl-faq/)에 따라 원본 글꼴 데이터를 보존한 WOFF2 압축본을 사용합니다.
- 생성 스크립트: `scripts/compress-fonts.py` (`fonttools[woff]` 4.67.0, Brotli 1.2.0).
- 글리프 테이블 변환을 끄고 압축한 뒤, 원본과 압축본의 테이블 데이터를 비교합니다. 컨테이너에 따라 달라지는 `head`의 체크섬·무손실 압축 비트와 실제 서명이 없는 빈 `DSIG` 테이블만 제외합니다. 이름·저작권·라이선스를 포함한 나머지 테이블은 동일합니다.
- 리디바탕: 1,453,448 → 457,732바이트. 본고딕: 10,414,588 → 4,306,608바이트.
- 원본 파일과 원본 라이선스 전문은 삭제하거나 수정하지 않습니다.

## 공식 출처와 파일 무결성

### 리디바탕

- 소개·라이선스 안내: https://ridicorp.com/ridibatang/
- 원본 파일: https://ridicorp.com/wp-content/themes/ridicorp/css/font/RIDIBatang.otf
- SHA-256: `f13a49c0815d254ac15e392953a0b056613dec08ceb378e54eeed14c4fda9a54`
- 저작권 고지는 원본 글꼴의 저작권 메타데이터와 공식 페이지를 함께 반영했습니다. OFL 전문은 [SIL 공식 원문](https://openfontlicense.org/documents/OFL.txt)의 예시 저작권 헤더를 실제 고지로 교체하여 첨부했습니다. 라이선스 본문은 변경하지 않았습니다.
- 리디주식회사에서 제공한 리디바탕 글꼴을 사용합니다.

### Pretendard Variable

- 공식 프로젝트: https://github.com/orioncactus/pretendard
- 고정 버전: `v1.3.9`
- 원본 파일: https://raw.githubusercontent.com/orioncactus/pretendard/v1.3.9/packages/pretendard/dist/web/variable/woff2/PretendardVariable.woff2
- 원본 라이선스: https://raw.githubusercontent.com/orioncactus/pretendard/v1.3.9/LICENSE
- SHA-256: `9599f12fd42fc0bce1cd50b47a0c022e108d7aa64dd0d1bb0ed44f3282d900b4`
- 제작·크레딧: 길형진. Inter: Rasmus Andersson. Source Han Sans: Adobe, Google, 산돌커뮤니케이션(장수영·강주연). M PLUS 1p: UNDERFOREST DESIGN(Coji Morishita).

### Noto Sans KR

- 공식 배포 저장소: https://github.com/google/fonts/tree/b38c5c93af322c45f633e17ac440ec1e6c94d489/ofl/notosanskr
- 고정 커밋: `b38c5c93af322c45f633e17ac440ec1e6c94d489`
- 원본 파일: https://raw.githubusercontent.com/google/fonts/b38c5c93af322c45f633e17ac440ec1e6c94d489/ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf
- 원본 라이선스: https://raw.githubusercontent.com/google/fonts/b38c5c93af322c45f633e17ac440ec1e6c94d489/ofl/notosanskr/OFL.txt
- SHA-256: `194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252`
- 저장소에서는 파일 경로만 `NotoSansKR-Variable.ttf`로 정리했습니다. 글꼴 파일의 바이트와 내부 이름은 원본과 동일합니다.