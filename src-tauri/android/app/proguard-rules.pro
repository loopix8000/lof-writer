# ML Kit이 런타임에 생성하는 구성 요소와 QR 스캐너 내부 코드를 보존한다.
# 코드 스캐너 16.1.0은 R8 전체 최적화에 필요한 보존 규칙을 포함하지 않는다.
-keep class com.google.mlkit.** { *; }
-keep class com.google.android.gms.internal.mlkit_code_scanner.** { *; }
