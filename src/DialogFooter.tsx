import { createContext, useContext, type HTMLAttributes } from "react";
import { createPortal } from "react-dom";

// 모바일 페이지가 제공하는 스크롤 밖의 버튼 영역. 데스크톱은 원래 위치에 그린다.
// submit 버튼은 form 속성으로 원래 입력 폼과 연결한다.
export const DialogFooterHost = createContext<HTMLElement | null | undefined>(undefined);

export default function DialogFooter({ className = "modal-footer", style, ...props }: HTMLAttributes<HTMLDivElement>) {
  const host = useContext(DialogFooterHost);
  const footer = <div {...props}
    className={`${className}${host !== undefined ? " m-dialog-footer" : ""}`}
    style={host === undefined ? style : { ...style, marginTop: 0 }} />;
  if (host === undefined) return footer;
  return host ? createPortal(footer, host) : null;
}
