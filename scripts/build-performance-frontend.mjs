import path from "node:path";
import { build } from "vite";

// 진단 번들에만 계측을 넣는다. 제품 소스와 기존 배포본은 바꾸지 않는다.
const root = path.resolve(import.meta.dirname, "..");
const output = path.resolve(process.argv[2] || ".test-data/continuous-input/frontend");
const functions = {
  "/core/text.mjs": ["requiresSource", "plainText", "splitSoftBreaks"],
  "/core/typing.mjs": ["inMarkdownCode", "typingPlan"],
  "/src/Writer.tsx": ["Writer", "cursorLineAt"],
  "/src/SourceEditor.tsx": ["countDelta", "inCode"],
  "/src/App.tsx": ["App"],
  "/src/manuscript-counts.ts": ["paragraphCountDelta"],
};
await build({
  root,
  build: { outDir: output, sourcemap: true },
  plugins: [{
    name: "입력-성능-계측", enforce: "pre",
    transform(code, id) {
      const names = Object.entries(functions).find(([suffix]) => id.replaceAll("\\", "/").endsWith(suffix))?.[1];
      if (!names) return;
      if (id.replaceAll("\\", "/").endsWith("/src/SourceEditor.tsx"))
        code = code.replace("viewRef.current = view;", "viewRef.current = view; if (globalThis.__perf) globalThis.__sourceEditor = view;");
      for (const name of names) {
        const pattern = new RegExp(`(export default |export )?function ${name}\\(`);
        const match = code.match(pattern);
        if (!match) throw Error(`계측 함수를 찾지 못했습니다: ${name}`);
        code = code.replace(pattern, `function __original_${name}(`);
        const prefix = match[1] || "";
        const parameters = id.endsWith(".tsx") || id.endsWith(".ts") ? `...args: Parameters<typeof __original_${name}>` : "...args";
        const bypass = name === "requiresSource" ? `if (globalThis.__perf?.bypassSource) { globalThis.__perf.record("requiresSource.bypassed", 0); return false; }` : "";
        code += `\n${prefix}function ${name}(${parameters}) { ${bypass} const start = performance.now(); try { return __original_${name}(...args); } finally { globalThis.__perf?.record(${JSON.stringify(name)}, performance.now() - start); } }\n`;
      }
      return { code, map: null };
    },
  }],
});
