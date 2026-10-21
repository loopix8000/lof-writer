import {_electron as electron,expect} from '@playwright/test';
import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';import assert from 'node:assert/strict';
import {Store} from '../core/store.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const data=path.join(root,'.test-data',`navigation-${Date.now()}`),vault=path.join(data,'vault'),user=path.join(data,'profile');
await fs.mkdir(user,{recursive:true});await fs.writeFile(path.join(user,'settings.json'),JSON.stringify({preferences:{setupComplete:true}}));
const store=await new Store(vault).init();const first=await store.createProject({title:'첫 작품'}),second=await store.createProject({title:'다른 작품'});
const a=await store.create({projectId:first.id,kind:'episode',title:'첫 원고',body:'처음 원고'});
const b=await store.create({projectId:first.id,kind:'episode',title:'둘째 원고',body:'둘째 본문'});
await store.create({projectId:first.id,kind:'wiki',title:'인물 설정',body:'설정 본문'});
await store.create({projectId:second.id,kind:'episode',title:'다른 작품 원고',body:'다른 본문'});
const env={...process.env,LOF_VAULT:vault,LOF_USER_DATA:user};delete env.ELECTRON_RUN_AS_NODE;
const options=process.env.LOF_TEST_PACKAGED==='1'?{executablePath:path.join(root,'release','win-unpacked','Lof Writer.exe'),args:[],env}:{args:[root],env};
let app;
try{
 app=await electron.launch(options);const page=await app.firstWindow(),header=page.locator('.titlebar'),contentHeader=page.locator('.workspace-header');
 const back=header.getByRole('button',{name:'뒤로가기',exact:true}),forward=header.getByRole('button',{name:'앞으로가기',exact:true});
 const title=page.getByRole('textbox',{name:'문서 제목',exact:true}),editor=page.locator('[data-testid="manuscript"]');
 await page.locator('.project-card').filter({hasText:'첫 작품'}).waitFor();
 await expect(back).toBeDisabled();await expect(forward).toBeDisabled();await expect(header).not.toContainText('Lof');await expect(header).not.toContainText('ALPHA');
 await page.locator('.project-card').filter({hasText:'첫 작품'}).click();
 await expect(back).toBeEnabled();await expect(forward).toBeDisabled();
 await page.locator('.episode-row').filter({hasText:'첫 원고'}).click();await expect(title).toHaveValue('첫 원고');
 await editor.fill('이동 직전에 쓴 한글 원고');await back.click();await page.locator('.project-tabs').waitFor();
 assert.equal((await store.read(a.id)).body,'이동 직전에 쓴 한글 원고');
 await forward.click();await expect(title).toHaveValue('첫 원고');await expect(editor).toContainText('이동 직전에 쓴 한글 원고');
 // Composition events must not block saving or history navigation.
 await editor.fill('조합 중 원고');await editor.dispatchEvent('compositionstart');await back.click();
 await page.locator('.project-tabs').waitFor();await expect(page.getByRole('alert')).toHaveCount(0);await expect(forward).toBeEnabled();
 assert.equal((await store.read(a.id)).body,'조합 중 원고');
 // A new destination after Back replaces the forward branch.
 await page.locator('.episode-row').filter({hasText:'둘째 원고'}).click();await expect(title).toHaveValue('둘째 원고');await expect(forward).toBeDisabled();
 await back.click();await page.locator('.project-tabs').waitFor();await forward.click();await expect(title).toHaveValue('둘째 원고');
 // Project tabs and archive state survive a history round trip.
 await back.click();await page.locator('.project-tabs').getByRole('button',{name:/위키 문서/}).click();
 await page.locator('.episode-row').filter({hasText:'인물 설정'}).click();await expect(title).toHaveValue('인물 설정');
 await back.click();await expect(page.locator('.project-tabs .selected').filter({hasText:'위키 문서'})).toBeVisible();await expect(page.locator('.episode-row')).toContainText('인물 설정');
 await page.getByRole('button',{name:'보관함',exact:true}).click();
 await page.locator('.rail').getByRole('button',{name:'도서관',exact:true}).click();await back.click();await expect(page.getByRole('button',{name:'보관함',exact:true})).toHaveClass('selected');
 // Repeated clicks on the current destination must not consume the future.
 await page.locator('.rail').getByRole('button',{name:'도서관',exact:true}).click();await page.locator('.rail').getByRole('button',{name:'도서관',exact:true}).click();
 await back.click();await page.locator('.project-tabs').waitFor();await forward.click();await page.locator('.project-card').first().waitFor();
 await page.locator('.project-card').filter({hasText:'다른 작품'}).click();await expect(contentHeader).toContainText('다른 작품');
 await page.locator('.episode-row').filter({hasText:'다른 작품 원고'}).click();await expect(title).toHaveValue('다른 작품 원고');await back.click();await expect(contentHeader).toContainText('다른 작품');
 // Creating a project also participates in navigation (including fresh metadata).
 await page.locator('.rail').getByRole('button',{name:'도서관',exact:true}).click();await page.getByRole('button',{name:'새 프로젝트',exact:true}).click();
 await page.getByRole('textbox',{name:'새 제목'}).fill('방금 만든 작품');await page.getByRole('button',{name:'만들기',exact:true}).click();await expect(contentHeader).toContainText('방금 만든 작품');
 await back.click();await page.locator('.project-card').filter({hasText:'방금 만든 작품'}).waitFor();await forward.click();await expect(contentHeader).toContainText('방금 만든 작품');
 await page.screenshot({path:path.join(root,'docs','navigation-alpha15.png')});
 // Switching vaults clears all routes to the previous vault.
 await page.locator('.rail').getByRole('button',{name:'도서관',exact:true}).click();const other=path.join(data,'other-vault');await new Store(other).init();
 await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},other);
 await page.getByRole('button',{name:'다른 도서관 열기',exact:true}).click();await page.getByRole('button',{name:'첫 프로젝트 만들기'}).waitFor();await expect(back).toBeDisabled();await expect(forward).toBeDisabled();
 console.log(JSON.stringify({passed:true,packaged:process.env.LOF_TEST_PACKAGED==='1',checks:['navigation boundaries','header without branding','save before travel','save rejection keeps route and cursor','back/forward restores manuscript','new branch discards future','project tab/archive restoration','duplicate destination','cross-project travel','new project history','vault resets history']},null,2));
}finally{if(app)await app.close();}
