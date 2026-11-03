(() => {
 if(window.__lofSyncDiagnostic) return 'already attached';
 const logs=[];
 const hash=s=>{let h=2166136261;for(let i=0;i<(s||'').length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);return(h>>>0).toString(16)};
 const meta=d=>d&&typeof d==='object'?{id:d.id,revision:d.revision,expectedRevision:d.expectedRevision,bodyLength:d.body?.length,bodyHash:d.body===undefined?undefined:hash(d.body),discardDraft:d.discardDraft,recoveryOnly:d.recoveryOnly,syncToken:d.syncToken}:d;
 const log=(event,data)=>{logs.push({at:new Date().toISOString(),event,data});if(logs.length>2000)logs.shift();console.info('LOF_SYNC_DIAGNOSTIC',JSON.stringify(logs.at(-1)))};
 const view=()=>{
   const node=document.getElementById('root'); const root=node&&Object.keys(node).find(k=>k.startsWith('__reactContainer$'));
   const tree=root?node[root].stateNode.current:null;const stack=tree?[tree]:[];let result={};let drafts=[];let retained=[];
   while(stack.length){const f=stack.pop();if(f.child)stack.push(f.child);if(f.sibling)stack.push(f.sibling);
     const p=f.memoizedProps;
     if(p&&typeof p.retrySync==='function'&&Object.hasOwn(p,'conflict'))result={...result,conflict:p.conflict,syncIssue:p.syncIssue,saveStatus:p.saveStatus,active:meta(p.active)};
     if(typeof f.type==='function'){let hook=f.memoizedState;let n=0;while(hook&&n++<300){const v=hook.memoizedState?.current;
       if(v?.doc&&v?.base&&Object.hasOwn(v,'saved'))drafts.push({doc:meta(v.doc),base:meta(v.base),seq:v.seq,saved:v.saved,draftSaved:v.draftSaved,edited:v.edited});
       if(v instanceof Map){const docs=[...v.values()].filter(x=>x&&typeof x.body==='string'&&x.id).map(meta);if(docs.length)retained.push(docs)}
       hook=hook.next;
     }}
   }
   return {...result,drafts,retained,visibility:document.visibilityState,pinLocked:document.documentElement.dataset.pinLocked,banner:document.querySelector('.sync-issue-banner')?.innerText};
 };
 for(const name of ['readDocument','saveDraft','saveDocument','adoptDocument','finishDocumentSync','saveRecoveryCopy','clearDraft','appLifecycle']){
   const original=window.lof[name];if(!original)continue;
   window.lof[name]=async function(args){const input=meta(args?.document||args);log(name+':start',input);try{const r=await original.apply(this,arguments);log(name+':end',{input,ok:r?.ok,error:r?.error,data:meta(r?.data)});return r}catch(e){log(name+':throw',{input,message:e?.message,code:e?.code});throw e}};
 }
 window.lof.onChange(()=>log('lof:change',view()));
 window.lof.onAutoSync(s=>log('lof:auto-sync',s));
 document.addEventListener('visibilitychange',()=>log('visibility',view()));
 let previous='';const timer=setInterval(()=>{const state=view(),s=JSON.stringify(state);if(previous!==s){previous=s;log('view',state)}},250);
 window.__lofSyncDiagnostic={logs,view,meta,timer};log('attached',view());return 'attached';
})()
