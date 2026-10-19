import { useRef, type RefObject } from "react";
import { call, type Doc, type Library } from "../types";

// 이미지 경로별 data URL을 재사용하고, 찾지 못한 경로는 다시 읽을 수 있게 한다.
export function useDocumentImages(libraryRef: RefObject<Library>, report: (error: unknown) => void) {
  const imageCache = useRef(new Map<string, Promise<string | null>>());
  function docImages(doc: Doc, editable: boolean) {
    const relPath = doc.relPath || libraryRef.current.documents.find((d) => d.id === doc.id)?.relPath || "";
    const up = "../".repeat(Math.max(0, relPath.split("/").length - 1));
    return {
      resolve: (src: string) => {
        const key = `${doc.projectId}\n${relPath}\n${src}`;
        let hit = imageCache.current.get(key);
        if (!hit) {
          hit = call<string | null>("readImage", { projectId: doc.projectId, docPath: relPath, src })
            .catch(() => null)
            .then((url) => {
              if (!url) imageCache.current.delete(key);
              return url;
            });
          imageCache.current.set(key, hit);
        }
        return hit;
      },
      save: editable
        ? async (file?: { name: string; data: string }) => {
          try {
            const saved = await call<{ path: string; name: string } | null>("saveImage", {
              projectId: doc.projectId,
              ...file,
            });
            if (!saved) return null;
            const stem = saved.name.replace(/\.[^.]+$/, "");
            return { src: up + saved.path, alt: stem === "image" ? "" : stem };
          } catch (e) {
            report(e);
            return null;
          }
        }
        : undefined,
    };
  }

  return docImages;
}
