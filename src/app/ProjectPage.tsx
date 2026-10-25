import RecoveryCopies from "../RecoveryCopies";
import {
  Archive,
  ArrowLeft,
  ChevronRight,
  Feather,
  FileText,
  Plus,
  Search,
  Settings,
  Upload,
  X
} from "lucide-react";
import { useRef, useState } from "react";
import type * as React from "react";
import {
  STATUS_SHORT,
  normalizeStatus
} from "../../core/episode.mjs";
import { normalizeWriting, writingUnit } from "../../core/platforms.mjs";
import CoverImage from "../CoverImage";
import PillTabs from "../PillTabs";
import TagAddPopup from "../TagAddPopup";
import {
  call,
  type Doc,
  type Kind,
  type Library,
  type Project
} from "../types";
import { icons, labels } from "./document-ui";
import { patchProject, type LibraryChange } from "./library-changes";

import { type Dialog } from "./model";

type Props = {
  attempt: (fn: () => Promise<any>) => () => Promise<any>;
  goView: (next: "library" | "project" | "bookmarks", id?: string) => Promise<void>;
  docs: Doc[];
  project: Project;
  setDialog: React.Dispatch<React.SetStateAction<Dialog | null>>;
  prefs: Record<string, any>;
  refresh: () => Promise<Library | undefined>;
  changeLibrary: <T>(change: LibraryChange, run: () => Promise<T>) => Promise<T>;
  message: (text: string, action?: { label: string; run: () => void; }) => void;
  setViewer: React.Dispatch<React.SetStateAction<{ src: string; alt: string; } | null>>;
  tab: Kind;
  setTab: React.Dispatch<React.SetStateAction<Kind>>;
  count: (kind: Kind) => number;
  archive: boolean;
  setArchive: React.Dispatch<React.SetStateAction<boolean>>;
  openSearch: () => void;
  createDoc: (kind: Kind, opts?: { title?: string; episodeId?: string; }) => Promise<void>;
  openDoc: (id: string, pinned?: boolean) => Promise<void>;
  numberOf: (d: Doc) => any;
};

export default function ProjectPage({
  attempt,
  goView,
  docs,
  project,
  setDialog,
  prefs,
  refresh,
  changeLibrary,
  message,
  setViewer,
  tab,
  setTab,
  count,
  archive,
  setArchive,
  openSearch,
  createDoc,
  openDoc,
  numberOf,
}: Props) {
  const [tagPopupOpen, setTagPopupOpen] = useState(false);
  const tagBtnRef = useRef<HTMLButtonElement | null>(null);

  const saveProjectTags = (nextTags: string[]) => {
    void attempt(() =>
      changeLibrary(patchProject(project.id, { tags: nextTags }), () =>
        call("updateProject", { id: project.id, tags: nextTags }),
      ),
    )();
  };

  return (
    <div className="project-page">
      <button
        className="back-link"
        onClick={attempt(() => goView("library"))}
      >
        <ArrowLeft size={16} />
        내 서재
      </button>
      <div className="project-hero">
        <div>
          <div className="eyebrow">
            {docs.filter((d) => d.kind === "episode").length}편
          </div>
          <h1>{project.title}</h1>
          {project.description && <p>{project.description}</p>}
          <div className="project-tags">
            {(project.tags || []).map((t) => (
              <span className="tag-chip" key={t}>
                #{t}
                <button
                  type="button"
                  aria-label={`${t} 태그 삭제`}
                  onClick={() => saveProjectTags((project.tags || []).filter((x) => x !== t))}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
            <button
              ref={tagBtnRef}
              type="button"
              aria-label="작품 태그 추가"
              aria-expanded={tagPopupOpen}
              onClick={() => setTagPopupOpen((v) => !v)}
            >
              <Plus size={13} />
              태그 추가
            </button>
            {tagPopupOpen && (
              <TagAddPopup
                anchorEl={tagBtnRef.current}
                tags={project.tags || []}
                favorites={prefs.favoriteTags}
                onChange={saveProjectTags}
                onClose={() => setTagPopupOpen(false)}
              />
            )}
          </div>
          <div className="row gap">
            <button
              onClick={() =>
                setDialog({
                  type: "editProject",
                  value: project.title,
                  description: project.description,
                  tags: project.tags || [],
                  manualLineBreak: project.manualLineBreak ?? null,
                  writing: normalizeWriting(
                    project.writing || prefs.defaultWriting,
                  ),
                })
              }
            >
              <Settings size={16} />
              소설 관리하기
            </button>
            <button
              onClick={attempt(async () => {
                const result = await call("importFiles", { projectId: project.id });
                if (result) {
                  await refresh();
                  message(
                    `${result.count}편 가져옴${result.warnings.length ? " · " + result.warnings.join(" / ") : ""}`,
                  );
                }
              })}
            >
              <Upload size={16} />
              원고 가져오기
            </button>
          </div>
        </div>
        {!prefs.hideCovers && <div className="hero-cover">
          {project.coverData ? (
            <button
              className="cover-zoom"
              title="표지 크게 보기"
              onClick={() =>
                setViewer({ src: project.coverData!, alt: `${project.title} 표지` })
              }
            >
              <CoverImage
                src={project.coverData}
                alt={`${project.title} 표지`}
              />
            </button>
          ) : (
            <>
              <Feather size={62} />
              <span>YOUR STORY</span>
            </>
          )}
        </div>}
      </div>
      {archive && <RecoveryCopies projectId={project.id} openDoc={openDoc} />}
      <div className="project-tabs">
        <PillTabs<Kind>
          value={tab}
          label="작품 문서 분류"
          items={(["episode", "plot", "memo"] as Kind[]).map((kind) => {
            const Icon = icons[kind];
            return {
              value: kind,
              label: labels[kind],
              icon: <Icon size={16} />,
              count: count(kind),
            };
          })}
          onChange={setTab}
        />
        <div className="row gap">
          <button
            title="보관함"
            aria-label="보관함"
            className={archive ? "selected" : ""}
            onClick={() => setArchive((a) => !a)}
          >
            <Archive size={16} />
          </button>
          <button
            title="본문 검색 (Ctrl+Shift+F)"
            aria-label="본문 검색"
            onClick={openSearch}
          >
            <Search size={17} />
          </button>
          <button
            className="primary project-doc-create"
            onClick={attempt(() => createDoc(tab))}
          >
            <Plus size={15} aria-hidden="true" />
            <span>새 {labels[tab]}</span>
          </button>
        </div>
      </div>
      <div className="episode-list">
        {docs
          .filter((d) => d.kind === tab)
          .map((d) => (
            <button
              className="episode-row"
              key={d.id}
              onClick={attempt(() => openDoc(d.id))}
              onDoubleClick={attempt(() => openDoc(d.id, true))}
            >
              <span className={`list-number${/^\d/.test(numberOf(d)) ? "" : " named"}`}>
                {numberOf(d)}
              </span>
              <b>{d.title}</b>
              {(d.archived || d.kind === "episode") && (
                <span
                  className={`status-chip ${!d.archived && normalizeStatus(d.status) === "completed" ? "complete" : ""}`}
                >
                  {d.archived ? "보관됨" : STATUS_SHORT[normalizeStatus(d.status)]}
                </span>
              )}
              <span className="episode-meta">
                {(d.platformCharacters ?? d.characters ?? 0).toLocaleString()}{writingUnit(normalizeWriting(project.writing || prefs.defaultWriting))}
              </span>
              <time>
                {new Date(d.updatedAt).toLocaleDateString("ko-KR")}
              </time>
              <ChevronRight size={16} />
            </button>
          ))}
        {!count(tab) && (
          <div className="empty-state">
            <FileText size={32} />
            <h3>아직 {labels[tab]}가 없습니다</h3>
            <p>새 문서를 만들거나 기존 원고를 가져오세요.</p>
          </div>
        )}
      </div>
    </div>
  );
}
