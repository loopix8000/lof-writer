type PendingEditor = { id: string; pending: () => boolean; composing: () => boolean; flush: () => void };
const editors = new Set<PendingEditor>();

// 저장·복사·전환 직전에 지연된 Markdown을 먼저 세션에 전달한다.
export function registerEditorDraft(editor: PendingEditor) {
  editors.add(editor);
  return () => { editors.delete(editor); };
}

export function flushEditorDrafts(id?: string) {
  for (const editor of editors)
    if ((id === undefined || editor.id === id) && editor.pending()) editor.flush();
}

export function hasEditorDraft(id: string) {
  for (const editor of editors) if (editor.id === id && editor.pending()) return true;
  return false;
}

export function hasComposingEditorDraft(id: string) {
  for (const editor of editors) if (editor.id === id && editor.pending() && editor.composing()) return true;
  return false;
}
