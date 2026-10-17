import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { EditorContent, useEditor } from "@tiptap/react";
import { EditorState } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Writer from "../../src/Writer";
import { createCachedMarkdown } from "../../src/cached-markdown";
import { MarkdownTables } from "../../src/table-extension";
import { MarkdownImage } from "../../src/image-extension";
import { TypingAssist } from "../../src/typing-extension";
import { Bookmarks } from "../../src/bookmark-extension";
import { NoteMarks } from "../../src/note-extension";
import { paragraphCountDelta } from "../../src/manuscript-counts";
import { needsMarkdownCopy } from "../../src/source-protection";
import { splitSoftBreaks } from "../../core/text.mjs";
import { normalizeWriting } from "../../core/platforms.mjs";
import "../../src/style.css";
import "./lab.css";

declare global {
  interface Window { __lab: any; __labEditor: any; __labSource: any; __labMeasure: any; }
}

const lab: any = window.__lab = {
  active: false, stages: {} as Record<string, number[]>, keys: [] as any[],
  frames: [] as any[], renders: 0, inputs: 0, updates: 0, longTasks: [] as any[],
};
window.__labMeasure = function<T>(name: string, fn: () => T): T {
  if (!lab.active) return fn();
  const start = performance.now();
  try { return fn(); }
  finally { (lab.stages[name] ||= []).push(performance.now() - start); }
};
const timed = window.__labMeasure;
// 상태 적용과 DOM 갱신은 포함 시간이다. 안쪽 단계의 시간과 더하지 않는다.
for (const [prototype, method, label] of [
  [EditorState.prototype, "applyTransaction", "state.applyTransaction"],
  [EditorView.prototype, "updateState", "view.updateState"],
] as const) {
  const original = (prototype as any)[method];
  (prototype as any)[method] = function(...args: any[]) {
    return timed(label, () => original.apply(this, args));
  };
}
document.addEventListener("keydown", event => {
  if (!lab.active || event.key !== "a") return;
  const key = { start: performance.now(), eventTime: event.timeStamp, repeat: event.repeat };
  lab.keys.push(key);
  requestAnimationFrame(() => {
    const frame = { key: lab.keys.indexOf(key), first: performance.now(), second: 0 };
    lab.frames.push(frame);
    requestAnimationFrame(() => { frame.second = performance.now(); });
  });
}, true);
document.addEventListener("input", () => { if (lab.active) lab.inputs++; }, true);
new PerformanceObserver(list => {
  if (lab.active) lab.longTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, ms: entry.duration })));
}).observe({ type: "longtask" });

const rules = normalizeWriting();
const options = { hardBreakIndent: false, indent: 1 };
const params = new URLSearchParams(location.search);
const mode = params.get("mode") || "full";
const source = mode === "source";
const corpus = await (await fetch("/fixture.md")).text();
const useSerialize = !["no-serialize", "engine-only", "minimal", "visibility-engine"].includes(mode);
const useReact = !["no-react", "engine-only", "minimal", "visibility-engine"].includes(mode);
const useCounts = !["engine-only", "minimal", "visibility-engine"].includes(mode);

function instrumentEditor(editor: any) {
  if (!editor || editor.__labInstrumented) return;
  editor.__labInstrumented = true;
  window.__labEditor = editor;
  const dispatch = editor.view.props.dispatchTransaction;
  editor.view.setProps({ dispatchTransaction: function(tr: any) {
    return timed("dispatch.total", () => dispatch.call(this, tr));
  } });
  // 확장별 처리는 실제 구현을 호출하고 결과도 그대로 돌려준다.
  for (const plugin of editor.state.plugins) {
    for (const [owner, method] of [[plugin.spec.state, "apply"], [plugin.spec, "appendTransaction"], [plugin.props, "decorations"]] as any[]) {
      if (!owner?.[method]) continue;
      const fn = owner[method];
      owner[method] = function(...args: any[]) {
        return timed(`plugin.${plugin.key}.${method}`, () => fn.apply(this, args));
      };
    }
  }
}

function SmallEngine({ changed }: { changed: (body?: string) => void }) {
  const markdown = useMemo(createCachedMarkdown, []);
  const initialContent = useMemo(() => splitSoftBreaks(corpus, true), []);
  const latest = useRef(changed); latest.current = changed;
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ document: false, link: false, underline: false }),
      markdown.document, markdown.extension,
      ...(mode === "minimal" ? [] : [
        MarkdownTables, MarkdownImage,
        TypingAssist.configure({ getOptions: () => options }),
        Bookmarks.configure({ canToggle: () => false }), NoteMarks,
        Placeholder.configure({ placeholder: "", showOnlyWhenEditable: false }),
      ]),
    ],
    content: initialContent, contentType: "markdown",
    editorProps: { attributes: { spellcheck: "false" } },
    onUpdate({ editor, transaction }) {
      if (lab.active) lab.updates++;
      if (useCounts) paragraphCountDelta(transaction.before, editor.state.doc, rules);
      const body = useSerialize ? markdown.serialize(editor) : undefined;
      if (useCounts) needsMarkdownCopy(editor.state.doc);
      if (useReact) latest.current(body);
    },
  }, []);
  useEffect(() => { instrumentEditor(editor); }, [editor]);
  return <EditorContent className="editor-content" editor={editor} />;
}

function App() {
  const [body, setBody] = useState(corpus), [version, setVersion] = useState(0);
  const [line, setLine] = useState(1);
  useLayoutEffect(() => { if (lab.active) lab.renders++; });
  const changed = (next?: string) => {
    if (next !== undefined) setBody(next);
    setVersion(value => value + 1);
  };
  useEffect(() => { lab.mounted = true; }, []);
  return <div className={`app lab-app ${["content-visibility", "visibility-engine"].includes(mode) ? "lab-windowed" : ""}`}>
    <header>긴 원고 입력 실험 · {mode} · 변경 {version} · {line}행</header>
    <div className="editor-scroll"><main className="manuscript">
      {["writer", "writer-no-cursor", "source"].includes(mode) ? <Writer
        id="lab" body={body} onChange={next => { if (lab.active) lab.updates++; changed(next); }}
        fontSize={18} lineHeight={2} source={source} onComposition={() => {}}
        typingOptions={options} countingRules={rules} revision="lab" tables
        images={{ resolve: async () => null }} onCursorLine={mode === "writer-no-cursor" ? undefined : setLine}
      /> : <SmallEngine changed={changed} />}
    </main></div>
  </div>;
}
createRoot(document.getElementById("root")!).render(<App />);
lab.instrument = () => { if (window.__labEditor) instrumentEditor(window.__labEditor); };
lab.reset = () => {
  lab.stages = {}; lab.keys = []; lab.frames = []; lab.renders = 0;
  lab.inputs = 0; lab.updates = 0; lab.longTasks = []; lab.active = true;
};
lab.snapshot = () => {
  lab.active = false;
  const editor = window.__labEditor, cm = window.__labSource;
  const text = source ? cm.state.doc.toString() : editor.state.doc.textContent;
  return { stages: lab.stages, keys: lab.keys, frames: lab.frames, renders: lab.renders,
    inputs: lab.inputs, updates: lab.updates, longTasks: lab.longTasks,
    textLength: text.length, tail: text.slice(-100),
    blocks: source ? cm.state.doc.lines : editor.state.doc.childCount,
    elements: document.querySelectorAll(source ? ".cm-editor *" : ".tiptap *").length,
  };
};
