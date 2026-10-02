import { chromium } from '/home/drew/code/_wt/builder-picker-20261002/node_modules/@playwright/test/index.mjs'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
const out='/tmp/picker761-native-browser'; await mkdir(out,{recursive:true})
const browser=await chromium.launch({headless:true})
const context=await browser.newContext({viewport:{width:1280,height:900},recordVideo:{dir:out}})
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));const checks=[]
const go=async(id,theme='dark')=>{await page.goto('http://127.0.0.1:6091/iframe.html?id=chatcontrols-'+id+'&viewMode=story&globals=agentTheme:agent-'+theme);await page.locator('#storybook-root button').first().waitFor()}
const dialog=()=>page.getByRole('dialog',{name:'Choose a model'})
const check=async(name,fn)=>{await fn();checks.push(name);console.log('PASS '+name)}
await check('recovery preserves value, focus, and viewport geometry',async()=>{
 await go('modelpicker--recovery');await dialog().waitFor();await page.screenshot({path:out+'/recovery-failure.png'});
 await page.getByRole('button',{name:'Retry',exact:true}).click(); await page.getByRole('status').filter({hasText:'Loading models'}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'Search all models'}).evaluate(e=>e===document.activeElement),true)
 await page.getByRole('button',{name:/Claude/}).first().waitFor();assert.equal(await page.locator('output').textContent(),'private/retained-model');
 const search=page.getByRole('textbox',{name:'Search all models'});await search.fill('no-matches-zz');await page.getByText('No models match your search').waitFor();
 assert.equal(await search.evaluate(e=>e===document.activeElement),true);const box=await dialog().boundingBox();assert(box.y>=0&&box.y+box.height<=900)
 await search.fill('');await search.press('ArrowDown');await page.keyboard.press('Enter');await dialog().waitFor({state:'hidden'});
 assert.equal(await page.getByRole('button',{name:'Default model',exact:true}).evaluate(e=>e===document.activeElement),true);assert.notEqual(await page.locator('output').textContent(),'private/retained-model')
 await page.screenshot({path:out+'/recovery-selected.png'})
})
await check('portal Tab exits beside trigger and Escape restores focus',async()=>{
 await go('modelpicker--recovery');await dialog().waitFor();const search=page.getByRole('textbox',{name:'Search all models'});await search.press('Shift+Tab');await dialog().waitFor({state:'hidden'});
 const trigger=page.getByRole('button',{name:'Default model',exact:true});assert(await trigger.evaluate(e=>e===document.activeElement));await trigger.press('Space');await dialog().waitFor();await search.press('Escape');assert(await trigger.evaluate(e=>e===document.activeElement));
 await trigger.press('Enter');await search.press('Tab');await page.keyboard.press('Tab');assert(await page.getByRole('button',{name:'Next setting'}).evaluate(e=>e===document.activeElement))
})
for(const id of ['inline','compact','inline-harness-locked','compact-harness-locked'])await check('AgentSessionControls '+id,async()=>{
 await go('agentsessioncontrols--'+id);const trigger=page.locator('button[aria-haspopup="dialog"]').first();await trigger.click();await dialog().waitFor();await page.getByRole('textbox',{name:'Search all models'}).fill('Claude');await dialog().getByRole('button',{name:/Claude/}).first().click();assert(await trigger.evaluate(e=>e===document.activeElement));await page.screenshot({path:out+'/session-'+id+'.png'})
})
for(const width of [1440,1280,390,320])for(const theme of ['light','dark'])await check('long names '+width+' '+theme,async()=>{
 await page.setViewportSize({width,height:width===320?568:width===390?844:900});await go('modelpicker--long-model-names',theme);await dialog().waitFor();const box=await dialog().boundingBox();assert(box.x>=0&&box.x+box.width<=width);assert(await dialog().evaluate(e=>e.scrollWidth<=e.clientWidth+1));await page.screenshot({path:out+'/long-'+width+'-'+theme+'.png'})
})
await check('disabled triggers do not open',async()=>{await go('modelpicker--disabled');for(const button of await page.locator('#storybook-root button').all())assert(await button.isDisabled())})
assert.deepEqual(errors,[]);await writeFile(out+'/results.json',JSON.stringify({checks,errors},null,2));await context.close();await browser.close();console.log('Completed '+checks.length+' checks')
