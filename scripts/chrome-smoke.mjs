import {_electron as electron,expect} from '@playwright/test';
import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),data=path.join(root,'.test-data',`chrome-${Date.now()}`),user=path.join(data,'profile');
await fs.mkdir(user,{recursive:true});await fs.writeFile(path.join(user,'settings.json'),JSON.stringify({preferences:{setupComplete:true}}));
const env={...process.env,LOF_USER_DATA:user,LOF_VAULT:path.join(data,'vault')};delete env.ELECTRON_RUN_AS_NODE;
const options=process.env.LOF_TEST_PACKAGED==='1'?{executablePath:path.join(root,'release','win-unpacked','Lof Writer.exe'),args:[],env}:{args:[root],env};let app;
try{
 app=await electron.launch(options);const page=await app.firstWindow();await page.locator('.workspace-header').waitFor();
 await expect.poll(()=>page.evaluate(()=>navigator.windowControlsOverlay?.visible)).toBe(true);
 const metrics=await page.evaluate(()=>{
  const rect=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
  return {top:rect(document.querySelector('.titlebar')),body:rect(document.querySelector('.workspace-header')),rail:rect(document.querySelector('.rail')),back:rect(document.querySelector('[aria-label="뒤로가기"]')),safe:rect(document.querySelector('.titlebar-content')),overlay:rect({getBoundingClientRect:()=>navigator.windowControlsOverlay.getTitlebarAreaRect()}),width:innerWidth,drag:getComputedStyle(document.querySelector('.titlebar')).webkitAppRegion,buttonDrag:getComputedStyle(document.querySelector('[aria-label="뒤로가기"]')).webkitAppRegion};
 });
 assert.equal(metrics.top.y,0);assert.equal(metrics.top.height,40);assert.equal(metrics.body.y,40);assert.equal(metrics.rail.y,40);assert.ok(metrics.back.y<10);assert.ok(metrics.back.bottom<=40);assert.ok(metrics.safe.right<=metrics.overlay.right+1);assert.ok(metrics.overlay.right<=metrics.width-100);assert.equal(metrics.drag,'drag');assert.equal(metrics.buttonDrag,'no-drag');
 await expect(page.locator('.workspace-header > strong')).toHaveText('Lof Writer');await expect(page.locator('.titlebar')).not.toContainText('Lof Writer');
 const bounds=await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];return{outer:w.getBounds(),content:w.getContentBounds()};});
 assert.ok(bounds.outer.height-bounds.content.height<=18,'Native title row must not consume extra height');
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0],original=w.setTitleBarOverlay.bind(w);w.setTitleBarOverlay=options=>{globalThis.lofOverlayOptions=options;return original(options);};});
 for(const [colorTheme,theme,color,symbolColor]of[['modern','light','#f8f8f8','#3b3b3b'],['modern','dark','#181818','#cccccc'],['bakery','light','#f9f9f7','#0b0b0b'],['bakery','dark','#0b0b0b','#f0efec']]){
  await page.evaluate(async prefs=>{const r=await window.lof.setPreferences(prefs);if(!r.ok)throw Error(r.error);}, {colorTheme,theme});
  const overlay=await app.evaluate(()=>globalThis.lofOverlayOptions);assert.equal(overlay.color,color);assert.equal(overlay.symbolColor,symbolColor);assert.equal(overlay.height,40);
 }
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].maximize());await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isMaximized())).toBe(true);
 await expect.poll(()=>page.evaluate(()=>Math.round(document.querySelector('.titlebar').getBoundingClientRect().y))).toBe(0);
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].unmaximize());await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isMaximized())).toBe(false);
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].minimize());await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isMinimized())).toBe(true);await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].restore());
 await page.keyboard.press('F11');await expect(page.locator('.workspace-header')).toBeHidden();await expect(page.locator('.titlebar')).toBeVisible();await page.keyboard.press('F11');
 await page.screenshot({path:path.join(root,'docs','titlebar-alpha15.png')});
 console.log(JSON.stringify({passed:true,packaged:process.env.LOF_TEST_PACKAGED==='1',metrics,bounds,checks:['native title row removed','navigation in top 40px','Lof Writer in content header','native controls safe area','drag and button hit regions','four theme overlay colors','maximize/restore/minimize','focus retains window controls']},null,2));
}finally{if(app)await app.close();}
