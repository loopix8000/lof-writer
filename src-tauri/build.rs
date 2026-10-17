fn main() {
    // 배포 리소스가 갱신되면 실행 파일에 포함하는 리소스도 다시 생성한다.
    println!("cargo:rerun-if-changed=../dist");
    tauri_build::build()
}
