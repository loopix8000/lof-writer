// 연결한 디버그 앱의 PID로 먼저 전달한다:
// adb -s <device> forward tcp:19326 localabstract:webview_devtools_remote_<pid>
// 진단 연결: node scripts/android-webview-cdp.mjs --file scripts/android-sync-diagnostic.js
// 로그 조회: node scripts/android-webview-cdp.mjs 'window.__lofSyncDiagnostic.logs'
import fs from 'node:fs';
const targets=await (await fetch('http://127.0.0.1:19326/json/list')).json();
const target=targets.find(t=>t.type==='page' && /tauri|localhost/.test(t.url)) || targets.find(t=>t.type==='page');
if(!target) throw Error('No WebView page');
const ws=new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
let seq=0;const pending=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result)}};
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
const expression=process.argv[2]==='--file'?fs.readFileSync(process.argv[3],'utf8'):process.argv[2];
try { const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});console.log(JSON.stringify(r,null,2)); } finally {ws.close()}
