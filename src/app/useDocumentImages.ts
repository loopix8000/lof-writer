import { useRef, type RefObject } from "react";
import { call, type Doc, type Library } from "../types";

// 이미지를 둘 곳과 원고 파일 경로. projectId는 작품 폴더 기준, space가 common이면 공용 메모 폴더 기준이다.
export type ImageScope = { projectId?: string; space?: string; docPath: string };

// 메모 화면의 메모. 공용 메모는 공용 메모 폴더의 assets/에, 작품 메모(doc/)는 작품의 assets/에 둔다.
export const memoImageScope = (space: string, path: string): ImageScope =>
  space === "common" ? { space, docPath: path } : { projectId: space, docPath: `doc/${path}` };

// 이미지 경로별 data URL을 재사용하고, 찾지 못한 경로는 다시 읽을 수 있게 한다.
export function useImages(report: (error: unknown) => void) {
  const imageCache = useRef(new Map<string, Promise<string | null>>());
  function images(scope: ImageScope, editable: boolean) {
    const { docPath, ...target } = scope;
    const up = "../".repeat(Math.max(0, docPath.split("/").length - 1));
    return {
      resolve: (src: string) => {
        const key = `${target.space ?? target.projectId}\n${docPath}\n${src}`;
        let hit = imageCache.current.get(key);
        if (!hit) {
          hit = call<string | null>("readImage", { ...target, docPath, src })
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
              ...target,
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

  return images;
}

export function useDocumentImages(libraryRef: RefObject<Library>, report: (error: unknown) => void) {
  const images = useImages(report);
  function docImages(doc: Doc, editable: boolean) {
    const relPath = doc.relPath || libraryRef.current.documents.find((d) => d.id === doc.id)?.relPath || "";
    return images({ projectId: doc.projectId, docPath: relPath }, editable);
  }

  return docImages;
}
