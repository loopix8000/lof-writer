import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function writeLabSummary(report, output) {
  const { sizes, modes, samples, interval, repetitions, position, layout } = report;
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] || 0;
  const lines = ["# 긴 원고 입력 실험", "", `입력: ${samples}자, ${interval}ms 간격, ${repetitions}회 반복. 위치: ${position}. 문서 구성: ${layout}.`, "",
    "각 반복의 p95 중앙값. 다음 프레임은 화면 갱신 기회까지의 대용 지표이며 실제 픽셀 표시 시간은 아니다.", "",
    "| 글자 수 | 비교군 | 입력 대기 p95(ms) | 다음 프레임 p95(ms) | 전체 처리/입력(ms) | Markdown/입력(ms) | 상태 적용/입력(ms) | DOM 갱신/입력(ms) | 배치 합계(ms) |", "|---:|---|---:|---:|---:|---:|---:|---:|---:|"];
  for (const size of sizes) for (const mode of modes) {
    const rows = report.results.filter(row => row.size === size && row.mode === mode);
    if (report.errors.some(error => error.size === size && error.mode === mode)) {
      lines.push(`| ${size} | ${mode} (오류, 제외) | — | — | — | — | — | — | — |`);
      continue;
    }
    if (!rows.length) continue;
    const value = fn => median(rows.map(fn)).toFixed(2);
    const stage = name => rows.some(row => row.stages[name]) ? value(r => (r.stages[name]?.total || 0) / samples) : "—";
    lines.push(`| ${size} | ${mode} | ${value(r => r.queueMs.p95)} | ${value(r => r.nextFrameMs.p95)} | ${stage("dispatch.total")} | ${stage("markdown.serialize")} | ${stage("state.applyTransaction")} | ${stage("view.updateState")} | ${value(r => r.metrics.LayoutDuration * 1000)} |`);
  }
  lines.push("", "상태 적용·DOM 갱신·Markdown 변환은 전체 처리 시간에 포함된다. 서로 더하지 않는다.", "", "전체 앱의 자동 저장·백그라운드 집계·사이드바·Rust/IPC는 이 실험에 포함하지 않았다. 입력은 CDP의 실제 키 이벤트를 사용했으며 한글 IME 조합 입력과는 구분한다.", "", `입력 파일 보존: ${report.fixtureUnchanged ? "SHA-256 일치" : "미확인"}. 완료 비교 횟수: ${report.results.length}.`);
  if (report.errors.length) lines.push("", `화면 또는 검증 오류 ${report.errors.length}건. 해당 비교군의 수치는 결론에서 제외한다. 원시 결과와 오류는 report.json에 남긴다.`);
  if (report.stability) {
    lines.push("", "## 편집 동작 안정성", "", "| 글자 수 | 비교군 | 반복 | 통과/전체 |", "|---:|---|---:|---:|");
    for (const row of report.results) {
      const checks = row.stability?.checks || [];
      lines.push(`| ${row.size} | ${row.mode} | ${row.repeat + 1} | ${checks.filter(check => check.ok).length}/${checks.length} |`);
      for (const check of checks.filter(check => !check.ok)) lines.push(`\n실패: ${row.size}/${row.mode}/${check.name}: ${check.error || "본문 불일치"}`);
    }
    lines.push("", "한글 조합은 CDP 조합 이벤트 모의 검증이다. 실제 Windows IME의 실사용 검증과 구분한다. 디스크 자동 저장·복원은 포함하지 않는다.");
  }
  lines.push("", "— 표시는 해당 비교군에서 실행하지 않았거나 계측하지 않은 단계다.");
  await fs.writeFile(path.join(output, "report.md"), lines.join("\n"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = path.resolve(process.argv[2] || ".test-data/rich-editor-lab");
  await writeLabSummary(JSON.parse(await fs.readFile(path.join(output, "report.json"), "utf8")), output);
  console.log(`결과 요약: ${path.join(output, "report.md")}`);
}
