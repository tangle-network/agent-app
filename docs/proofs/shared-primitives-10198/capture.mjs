import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
const require = createRequire(process.cwd() + '/package.json');
const { chromium } = require('playwright');
const phase = process.argv[2];
const dir = `${process.env.PROOF_RUN_DIR}/${phase}`;
if (!process.env.PROOF_RUN_DIR) throw new Error('A declared proof run directory is required');
await fs.mkdir(dir, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const receipts = [];
const storyId = 'app-shell-shared-primitives--interactive';
const matrix = [['agent-dark',1280,1000],['agent-light',1280,1000],['agent-dark',390,844],['agent-light',390,844]];
const conditions = phase === 'before' ? ['normal'] : ['normal','interrupted','reduced-motion'];
const animations = page => page.evaluate(() => document.getAnimations().map(animation => ({
  playState: animation.playState, timing: animation.effect?.getTiming(),
  target: animation.effect?.target?.outerHTML?.slice(0,300), frames: animation.effect?.getKeyframes(),
})));
const assertReduced = async page => {
 const result = await page.evaluate(async () => {
  const observations=[],failures=[],unresolved=[];
  const active=document.getAnimations().filter(animation=>animation.playState==='running');
  const nodes=new Set([...document.querySelectorAll('[role="dialog"],[role="tooltip"]')]);
  const identity=()=>new DOMMatrixReadOnly();
  const matrix=(property,value)=>{
   if(value==='none')return identity();
   if(property==='transform')return new DOMMatrixReadOnly(String(value));
   const parts=String(value).trim().split(/\s+/);
   if(property==='translate'){
    if(parts.some(part=>!/^[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:px)?$/.test(part)))throw new Error('Unresolved translate unit');
    const values=parts.map(parseFloat);return identity().translate(values[0],values[1]??0,values[2]??0);
   }
   if(property==='scale'){
    const values=parts.map(part=>part.endsWith('%')?Number(part.slice(0,-1))/100:Number(part));
    if(values.some(value=>!Number.isFinite(value)))throw new Error('Unresolved scale');
    return identity().scale(values[0],values[1]??values[0],values[2]??1);
   }
   if(property==='rotate'&&parts.length===1){
    const angle=/^([-+]?(?:\d+(?:\.\d+)?|\.\d+))(deg|rad|turn|grad)$/.exec(parts[0]);
    if(!angle)throw new Error('Unresolved rotate');
    const degrees=Number(angle[1])*({deg:1,rad:180/Math.PI,turn:360,grad:.9}[angle[2]]);
    return identity().rotate(degrees);
   }
   throw new Error('Unsupported spatial keyframe');
  };
  for(const animation of active){
   const target=animation.effect?.target;
   if(!(target instanceof Element)){unresolved.push('Active animation target unavailable');continue}
   nodes.add(target);
   const style=getComputedStyle(target),frames=animation.effect.getKeyframes(),timing=animation.effect.getTiming();
   const observation={kind:animation.constructor.name,name:animation.animationName??null,transitionProperty:animation.transitionProperty??null,
    target:target.outerHTML.slice(0,700),timing,frames,normalized:{},
    scopedRoles:Object.fromEntries(['--motion-control','--motion-surface','--motion-dismiss','--interaction-feedback-budget'].map(role=>[role,style.getPropertyValue(role).trim()])),
    computed:{animationName:style.animationName,animationDuration:style.animationDuration,transitionProperty:style.transitionProperty,transitionDuration:style.transitionDuration,transform:style.transform,translate:style.translate,scale:style.scale}};
   if(timing.iterations>1)failures.push({reason:'Repeated animation while reduced',target:observation.target});
   for(const property of ['transform','translate','scale','rotate']){
    if(!frames.some(frame=>property in frame))continue;
    try{
     if(frames.length<2||frames.some(frame=>!(property in frame)))throw new Error('Incomplete spatial endpoints');
     const matrices=frames.map(frame=>Array.from(matrix(property,frame[property]).toFloat64Array()));
     if(matrices.flat().some(value=>!Number.isFinite(value)))throw new Error('Nonfinite matrix');
     observation.normalized[property]=matrices;
     if(matrices.some(values=>values.some((value,index)=>value!==matrices[0][index])))failures.push({reason:'Actual spatial keyframe change',property,target:observation.target,matrices});
    }catch(error){unresolved.push({reason:String(error),property,target:observation.target,frames})}
   }
   if(frames.some(frame=>frame.filter&&frame.filter!=='none'))failures.push({reason:'Filter keyframes while reduced',target:observation.target,frames});
   observations.push(observation);
  }
  const tracked=[...nodes];
  const sample=()=>({at:performance.now(),nodes:tracked.map(node=>{
   if(!node.isConnected)return {connected:false};
   const rect=node.getBoundingClientRect(),style=getComputedStyle(node);
   return {connected:true,role:node.getAttribute('role'),id:node.id,rect:[rect.x,rect.y,rect.width,rect.height],transform:Array.from(new DOMMatrixReadOnly(style.transform==='none'?undefined:style.transform).toFloat64Array()),translate:style.translate,scale:style.scale};
  })});
  const geometry=[sample()];
  for(let frame=0;frame<2;frame++){await new Promise(requestAnimationFrame);geometry.push(sample())}
  for(let index=0;index<tracked.length;index++){
   const first=geometry[0].nodes[index];
   if(geometry.some(row=>!row.nodes[index].connected)){failures.push({reason:'Tracked surface disappeared during reduced check',index});continue}
   if(geometry.some(row=>row.nodes[index].rect.some((value,i)=>value!==first.rect[i])||row.nodes[index].transform.some((value,i)=>value!==first.transform[i])))failures.push({reason:'Actual geometry or JS-applied transform changed across frame callbacks',index,samples:geometry.map(row=>row.nodes[index])});
  }
  return {observations,geometry,failures,unresolved,normalization:'DOMMatrixReadOnly; exact finite matrix equality, including none/identity equivalence',latency:'UNCHECKED: callback geometry is not calibrated presented-frame latency'};
 });
 if(result.failures.length||result.unresolved.length)throw new Error(`Reduced motion failed or unresolved: ${JSON.stringify(result)}`);
 return result;
};
try {
 let ready = false;
 for (let attempt=0; attempt<120; attempt++) {
  try { if ((await fetch('http://localhost:6198/iframe.html')).ok) { ready=true; break; } } catch {}
  await new Promise(resolve => setTimeout(resolve,1000));
 }
 if (!ready) throw new Error('Storybook did not become ready within120s');
 const indexResponse = await fetch('http://localhost:6198/index.json');
 const index = await indexResponse.json();
 await fs.writeFile(`${dir}/story-index.json`,JSON.stringify({status:indexResponse.status,entry:index.entries?.[storyId],ids:Object.keys(index.entries??{}).filter(id=>id.includes('shared'))},null,2));
 if (!index.entries?.[storyId]) throw new Error('Shared primitives story absent from served index; retained index receipt');
 for (const condition of conditions) for (const [theme,width,height] of matrix) {
  const name = `${theme}-${width}-${condition}`;
  const context = await browser.newContext({viewport:{width,height},reducedMotion:condition==='reduced-motion'?'reduce':'no-preference',recordVideo:{dir,size:{width,height}}});
  await context.tracing.start({screenshots:true,snapshots:true,sources:false});
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const errors=[],consoleErrors=[],requestFailures=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error'&&consoleErrors.length<100)consoleErrors.push(message.text())});
  page.on('requestfailed',request=>{if(requestFailures.length<100)requestFailures.push({url:request.url(),failure:request.failure()?.errorText})});
  const receipt={theme,width,height,condition,browser:browser.version(),errors,flow:'busy dialog/return, disclosure draft, grid edit, async action, settled terminal and synthetic API key',latency:'UNCHECKED: behavioral journeys are not2x40 latency batches or calibrated presented-frame measurements'};
  try {
   await page.goto(`http://localhost:6198/iframe.html?id=${storyId}&viewMode=story&globals=agentTheme:${theme}`,{waitUntil:'domcontentloaded',timeout:90000});
   await page.getByRole('heading',{name:'Shared application controls'}).waitFor({timeout:120000});
   await page.getByText('render --page page-1 --format png',{exact:true}).first().locator('xpath=ancestor::button[1]').click();
   const output=page.getByText('Rendered page-1 → out/poster.png (1080x1080)',{exact:true});
   await output.waitFor();
   receipt.terminal=await output.evaluate(element=>{
    const range=document.createRange();range.selectNodeContents(element);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
    const selected=selection.toString();selection.removeAllRanges();
    return {text:element.textContent,selected,whiteSpace:getComputedStyle(element).whiteSpace};
   });
   if(receipt.terminal.selected!==receipt.terminal.text || receipt.terminal.whiteSpace!=='pre-wrap')throw new Error('Terminal text selection or whitespace semantics changed');
   if(condition==='reduced-motion')receipt.reducedAtLoad=await assertReduced(page);
   await page.screenshot({path:`${dir}/${name}.png`,fullPage:true});
   const opener=page.getByRole('button',{name:'Rename profile',exact:true});
   await opener.click();
   if(phase==='after') {
    await page.waitForFunction(()=>document.activeElement?.closest('[role="dialog"]'));
    receipt.openAnimations=await animations(page);
   }
   if(condition==='interrupted') {
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({state:'hidden'});
    await page.waitForFunction(()=>document.activeElement?.textContent==='Rename profile');
    await opener.click();
    await page.getByRole('button',{name:'Cancel',exact:true}).click({force:true});
    await page.getByRole('dialog').waitFor({state:'hidden'});
    await opener.click();
   }
   await page.getByLabel('Profile name').fill('Checked assistant');
   await page.getByLabel('Write in flight').check();
   await page.mouse.click(5,5);
   if(await page.getByRole('dialog').count()!==1)throw new Error('Busy dialog dismissed by outside click');
   await page.keyboard.press('Escape');
   if(await page.getByRole('dialog').count()!==1)throw new Error('Busy dialog dismissed by Escape');
   if(phase==='after') {
    await page.emulateMedia({reducedMotion:'reduce'});
    receipt.reducedToggledInFlight=await assertReduced(page);
    if(condition!=='reduced-motion')await page.emulateMedia({reducedMotion:'no-preference'});
   }
   await page.getByLabel('Write in flight').uncheck();
   await page.screenshot({path:`${dir}/${name}-dialog.png`,fullPage:true});
   await page.getByRole('button',{name:'Save',exact:true}).click();
   await page.getByText('Saved profile: Checked assistant').waitFor();
   if(phase==='after') {
    await page.waitForFunction(()=>document.activeElement?.textContent==='Rename profile');
    await opener.click();
    if(await page.getByLabel('Profile name').inputValue()!=='Checked assistant')throw new Error('Saved name lost on reopen');
    await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
    await page.waitForFunction(()=>document.activeElement?.textContent==='Rename profile');
   }
   const disclosure=page.locator('summary').filter({hasText:'Advanced settings'}).or(page.getByRole('button',{name:'Advanced settings',exact:true}));
   await disclosure.focus();await disclosure.press('Enter');
   if(phase==='after') {
    await page.getByLabel('Advanced note').fill('Preserved draft');await disclosure.press('Enter');
    if(await page.getByLabel('Advanced note').isVisible())throw new Error('Closed disclosure remains visible');
    const anchor=page.locator('[data-design-anchor="saved-profile"]');
    const before=await anchor.boundingBox();await disclosure.press('Enter');const after=await anchor.boundingBox();
    if(await page.getByLabel('Advanced note').inputValue()!=='Preserved draft')throw new Error('Disclosure lost draft');
    receipt.anchor={id:'saved-profile',before,after,lineHeight:await anchor.evaluate(el=>getComputedStyle(el).lineHeight),focusDestination:'Advanced settings button (keyboard), Advanced note (fill)'};
   } else await page.getByText('Settings are reachable with the keyboard.').waitFor({state:'visible'});
   await page.getByRole('button',{name:'Create report'}).click();await page.getByText('Report created',{exact:true}).waitFor();
   await page.getByRole('gridcell').filter({hasText:'Review sources'}).click();
   const editor=page.getByRole('textbox',{name:/Task/});await editor.fill('Checked sources');await editor.press('Enter');
   await page.getByRole('gridcell').filter({hasText:'Checked sources'}).waitFor();
   await page.getByLabel('Name',{exact:true}).fill('QA client');await page.getByRole('button',{name:'Create key',exact:true}).click();
   await page.getByRole('heading',{name:'Save your key'}).waitFor();await page.getByRole('button',{name:'I’ve saved it'}).click();
   await page.screenshot({path:`${dir}/${name}-completed.png`,fullPage:true});
   if(phase==='after') {
    receipt.instrument=await page.evaluate(()=>window.__agentAppInteractionEvidence?.snapshot()??{status:'UNCHECKED',reason:'Catalog instrument unavailable'});
    receipt.calibration=await page.evaluate(()=>window.__agentAppInteractionEvidence?.calibrate()??{status:'UNCHECKED',reason:'Catalog instrument unavailable'});
   }
   receipt.environment=await page.evaluate(()=>({ua:navigator.userAgent,viewport:[innerWidth,innerHeight],dpr:devicePixelRatio,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,horizontalOverflow:document.documentElement.scrollWidth>innerWidth}));
   if(errors.length)throw new Error(`Page errors: ${errors.join('; ')}`);
   receipt.status='PASS';receipts.push(receipt);
  } catch(error) {
   receipt.instrument=await page.evaluate(()=>window.__agentAppInteractionEvidence?.snapshot()??{status:'UNCHECKED',reason:'Instrument unavailable on failed page'}).catch(problem=>({status:'UNCHECKED',reason:String(problem)}));
   receipt.status='FAIL';receipt.error=String(error);receipts.push(receipt);
   await Promise.allSettled([
    page.screenshot({path:`${dir}/${name}-failure.png`,fullPage:true,timeout:10000}),
    page.content().then(html=>fs.writeFile(`${dir}/${name}-failure.html`,html)),
    fs.writeFile(`${dir}/${name}-failure.json`,JSON.stringify({...receipt,url:page.url(),consoleErrors,requestFailures},null,2)),
   ]);throw error;
  } finally {
   await context.tracing.stop({path:`${dir}/${name}-trace.zip`}).catch(error=>console.error('Trace finalization:',String(error)));
   await context.close();await fs.writeFile(`${dir}/receipt.json`,JSON.stringify(receipts,null,2));
  }
 }
} finally {await browser.close()}
console.log(JSON.stringify(receipts.map(({theme,width,condition,status})=>({theme,width,condition,status}))));
