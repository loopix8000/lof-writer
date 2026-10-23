import { useState } from "react";
import { useConfirm } from "./ConfirmDialog";

export default function SyncIssueBanner({ issue, retry }: { issue: string; retry: (discard?: boolean) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [confirm, dialog] = useConfirm();
  const run = async (discard = false) => {
    if (busy) return;
    setBusy(true);
    try {
      if (discard && !await confirm({ title: "임시본을 삭제할까요?", message: "이 문서의 저장 전 편집을 버리고 최신 저장본을 불러옵니다. 보관함에 이미 저장한 복구 사본은 남습니다.", confirmLabel: "임시본 삭제 후 최신본 사용", danger: true })) return;
      setFailure("");
      await retry(discard);
    }
    catch (error: any) { setFailure(error?.message || "처리하지 못했습니다. 다시 시도해 주세요."); }
    finally { setBusy(false); }
  };
  return <>
    <div className="conflict-banner sync-issue-banner" role="status">
      <div>
        <span>이 문서의 충돌 정리가 필요합니다. 다른 문서는 계속 사용할 수 있습니다.</span>
        <details><summary>오류 내용</summary><p>{failure || issue}</p></details>
        <small>이 문서의 전송은 정리 후 재개됩니다. 복구 사본은 작품 보관함에서 확인할 수 있습니다.</small>
      </div>
      <div className="conflict-actions">
        <button disabled={busy} onClick={() => void run()}>{busy ? "처리 중…" : "다시 시도"}</button>
        <button disabled={busy} onClick={() => void run(true)}>임시본 삭제 후 최신본 사용</button>
      </div>
    </div>
    {dialog}
  </>;
}
