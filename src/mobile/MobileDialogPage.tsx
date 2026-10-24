import { ArrowLeft } from "lucide-react";
import { useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode, type RefObject } from "react";
import { DialogFooterHost } from "../DialogFooter";

type Props = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  title: string;
  onClose?: () => void;
  closeLabel?: string;
  bodyClassName?: string;
  panelRef?: RefObject<HTMLDivElement | null>;
  overlays?: ReactNode;
};

export default function MobileDialogPage({
  title, onClose, closeLabel = "닫기", bodyClassName = "", className = "", panelRef, overlays, children, ...props
}: Props) {
  const ownRef = useRef<HTMLDivElement>(null);
  const root = panelRef ?? ownRef;
  const [footerHost, setFooterHost] = useState<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const page = root.current;
    if (!page) return;
    const viewport = window.visualViewport;
    const updateViewport = () => {
      page.style.top = `${viewport?.offsetTop ?? 0}px`;
      page.style.left = `${viewport?.offsetLeft ?? 0}px`;
      page.style.width = `${viewport?.width ?? window.innerWidth}px`;
      page.style.height = `${viewport?.height ?? window.innerHeight}px`;
    };
    updateViewport();
    window.addEventListener("resize", updateViewport);
    viewport?.addEventListener("resize", updateViewport);
    viewport?.addEventListener("scroll", updateViewport);
    return () => {
      window.removeEventListener("resize", updateViewport);
      viewport?.removeEventListener("resize", updateViewport);
      viewport?.removeEventListener("scroll", updateViewport);
    };
  }, [root]);

  return <DialogFooterHost.Provider value={footerHost}>
    <div {...props} ref={root} className={`m-dialog-page ${className}`} role="dialog" aria-modal="true" aria-label={props["aria-label"] ?? title}>
      <header className="m-topbar m-topbar-centered">
        {onClose ? <button type="button" className="m-back-btn" onClick={onClose}>
          <ArrowLeft size={18} /><span>{closeLabel}</span>
        </button> : <div />}
        <div className="m-topbar-title"><h1>{title}</h1></div>
        <div className="m-topbar-actions" />
      </header>
      <div className={`m-dialog-body ${bodyClassName}`}>{children}</div>
      <div className="m-dialog-footer-host" ref={setFooterHost} />
      {overlays}
    </div>
  </DialogFooterHost.Provider>;
}
