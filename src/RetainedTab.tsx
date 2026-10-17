import { memo, type ReactNode } from "react";

// 숨겨진 탭도 마운트 상태를 유지하되, 선택되기 전까지 불필요한 렌더링을 건너뛴다.
const RetainedTab = memo(function RetainedTab({ visible, children }: {
  visible: boolean;
  children: ReactNode;
}) {
  return <div className="retained-tab" hidden={!visible} inert={!visible} aria-hidden={!visible}>
    {children}
  </div>;
}, (previous, next) => !previous.visible && !next.visible);

export default RetainedTab;
