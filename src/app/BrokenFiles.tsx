import {
  FileQuestion,
  FileWarning
} from "lucide-react";
import { type MenuItem } from "../ContextMenu";
import {
  call,
  type Doc,
  type Library
} from "../types";

import type * as React from "react";

type Props = {
  lib: Library;
  projectId: string;
  attempt: (fn: () => Promise<any>) => () => Promise<any>;
  refresh: () => Promise<Library | undefined>;
  message: (text: string, action?: { label: string; run: () => void; }) => void;
  openDoc: (id: string, pinned?: boolean) => Promise<void>;
  menu: { x: number; y: number; items: MenuItem[]; target?: string; } | null;
  openMenu: (e: React.MouseEvent, items: MenuItem[], target?: string) => void;
};

export default function BrokenFiles({ lib, projectId, attempt, refresh, message, openDoc, menu, openMenu }: Props) {


  const missing = (lib.missing || []).filter((m) => m.projectId === projectId),
    unlinked = (lib.unlinked || []).filter((u) => u.projectId === projectId);
  if (!missing.length && !unlinked.length) return null;
  const relink = (m: { id: string; title: string }): MenuItem[] => [
    ...(unlinked.length
      ? unlinked.map((u) => ({
        label: `이 파일에 연결: ${u.path}`,
        action: attempt(async () => {
          await call("relinkDocument", { projectId, id: m.id, path: u.path });
          await refresh();
          message(`'${m.title}'을(를) ${u.path}에 다시 연결했습니다.`);
        }),
      }))
      : [{ label: "연결할 수 있는 파일이 없습니다", disabled: true, action: () => { } }]),
    "separator",
    {
      label: "목록에서 빼기 (파일은 건드리지 않음)",
      danger: true,
      action: attempt(async () => {
        await call("forgetDocument", { projectId, id: m.id });
        await refresh();
      }),
    },
  ];
  const adopt = (u: { path: string }): MenuItem[] => [
    ...(["episode"] as const).map((kind) => ({
      label: "에피소드로 등록",
      action: attempt(async () => {
        const doc = await call<Doc>("adoptFile", { projectId, path: u.path, kind });
        await refresh();
        await openDoc(doc.id, true);
      }),
    })),
    "separator",
    {
      label: "파일 탐색기에서 표시",
      action: attempt(() => call("revealFile", { projectId, path: u.path })),
    },
  ];
  return (
    <section className="tree-section broken-files">
      <div className="tree-heading">
        <span>확인이 필요한 파일</span>
        <small>{missing.length + unlinked.length}</small>
      </div>
      {missing.map((m) => (
        <button
          key={"missing-" + m.id}
          className={`tree-item ${menu?.target === "missing-" + m.id ? "context-target" : ""}`}
          title={`${m.path} 파일을 찾을 수 없습니다. 눌러서 다른 파일에 연결하거나 목록에서 뺄 수 있습니다.`}
          onClick={(e) => openMenu(e, relink(m), "missing-" + m.id)}
          onContextMenu={(e) => openMenu(e, relink(m), "missing-" + m.id)}
        >
          <FileWarning size={15} />
          <span>{m.title || "제목 없음"}</span>
          <small className="tree-count">파일 없음</small>
        </button>
      ))}
      {unlinked.map((u) => (
        <button
          key={"unlinked-" + u.path}
          className={`tree-item ${menu?.target === "unlinked-" + u.path ? "context-target" : ""}`}
          title={`${u.path} 파일이 목록에 연결되어 있지 않습니다. 눌러서 회차나 플롯으로 등록할 수 있습니다.`}
          onClick={(e) => openMenu(e, adopt(u), "unlinked-" + u.path)}
          onContextMenu={(e) => openMenu(e, adopt(u), "unlinked-" + u.path)}
        >
          <FileQuestion size={15} />
          <span>{u.path.slice(u.path.lastIndexOf("/") + 1)}</span>
          <small className="tree-count">연결 안 됨</small>
        </button>
      ))}
    </section>
  );

}
