import type { Doc, Library, Project } from "../types";

// 백엔드 처리를 기다리지 않고 화면의 서재에 먼저 반영하는 변경.
// 처리 중에 다시 읽은 서재에도 덧씌우므로 같은 변경을 여러 번 적용해도 결과가 같아야 한다.
export type LibraryChange = (data: Library) => Library;

export function patchDocuments(ids: string[], patch: Partial<Doc>): LibraryChange {
  const targets = new Set(ids);
  return (data) => ({
    ...data,
    documents: data.documents.map((d) => (targets.has(d.id) ? { ...d, ...patch } : d)),
  });
}

export function removeDocuments(ids: string[]): LibraryChange {
  const targets = new Set(ids);
  return (data) => ({ ...data, documents: data.documents.filter((d) => !targets.has(d.id)) });
}

// 새로 만든 문서를 순서에 맞는 자리에 넣는다. 이미 다시 읽은 서재에 있으면 그대로 둔다.
export function insertDocument(doc: Doc): LibraryChange {
  const { body: _body, ...meta } = doc;
  return (data) => {
    if (data.documents.some((d) => d.id === doc.id)) return data;
    const documents = [...data.documents];
    const at = documents.findIndex((d) => d.order > doc.order);
    documents.splice(at < 0 ? documents.length : at, 0, meta as Doc);
    return { ...data, documents };
  };
}

// ids 순서대로 문서를 다시 놓는다. 서재 목록 안의 자리와 order 값은 그대로 두고 문서만 맞바꾼다.
export function reorderDocuments(ids: string[]): LibraryChange {
  return (data) => {
    const byId = new Map(data.documents.filter((d) => ids.includes(d.id)).map((d) => [d.id, d]));
    const sequence = ids.filter((id) => byId.has(id));
    const slots = data.documents.filter((d) => byId.has(d.id)).map((d) => d.order);
    let i = 0;
    const documents = data.documents.map((d) => {
      if (!byId.has(d.id)) return d;
      const next = byId.get(sequence[i])!,
        order = slots[i++];
      return next.order === order ? next : { ...next, order };
    });
    return { ...data, documents };
  };
}

export function patchProject(id: string, patch: Partial<Project>): LibraryChange {
  return (data) => ({
    ...data,
    projects: data.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)),
  });
}

export function insertProject(project: Project): LibraryChange {
  return (data) =>
    data.projects.some((p) => p.id === project.id) ? data : { ...data, projects: [...data.projects, project] };
}

export function removeProject(id: string): LibraryChange {
  return (data) => ({
    ...data,
    projects: data.projects.filter((p) => p.id !== id),
    documents: data.documents.filter((d) => d.projectId !== id),
  });
}

export function reorderProjects(ids: string[]): LibraryChange {
  return (data) => {
    const byId = new Map(data.projects.map((p) => [p.id, p]));
    const ordered = ids.map((id) => byId.get(id)).filter((p): p is Project => !!p);
    const rest = data.projects.filter((p) => !ids.includes(p.id));
    return { ...data, projects: [...ordered, ...rest] };
  };
}
