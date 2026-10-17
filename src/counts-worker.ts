import { plainText } from "../core/text.mjs";

// 본문 해석도 화면 스레드 밖에서 수행한다. 원문은 결과로 돌려보내지 않는다.
self.onmessage = (event: MessageEvent<{ sequence: number; body: string }>) => {
  try { self.postMessage({ sequence: event.data.sequence, text: plainText(event.data.body) }); }
  catch (error) { self.postMessage({ sequence: event.data.sequence, error: error instanceof Error ? error.message : String(error) }); }
};
