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
const storyId = phase === 'dismiss' ? 'app-shell-shared-primitives--dismiss' : 'app-shell-shared-primitives--interactive';
const matrix = phase === 'dismiss' ? [['agent-dark',390,844],['agent-light',1280,1000]] : [['agent-dark',1280,1000],['agent-light',1280,1000],['agent-dark',390,844],['agent-light',390,844]];
const conditions = phase === 'dismiss' ? ['normal','reduced-motion'] : phase === 'before' ? ['normal'] : ['normal','interrupted','reduced-motion'];
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


// Installed before navigation/first input; the timeline retains trusted input,
// focus and real surface lifecycle, including failures and late reopen attempts.
function installDismissTimeline() {
 const events=[],nodes=new Set(),ids=new WeakMap();let next=0,overflow=0;
 const token=node=>{if(!ids.has(node))ids.set(node,++next);return ids.get(node)};
 const surface=node=>{
  const style=node.isConnected?getComputedStyle(node):null;
  const raw=style?.animationDuration.split(',')[0].trim();
  const match=raw&&/^(\d+(?:\.\d+)?)(ms|s)$/.exec(raw);
  return {token:token(node),connected:node.isConnected,state:node.getAttribute('data-state'),animationName:style?.animationName??null,
   durationMs:match?Number(match[1])*(match[2]==='s'?1000:1):null,
   dismissRole:style?.getPropertyValue('--motion-dismiss').trim()??null};
 };
 const push=(kind,extra={})=>{if(events.length>=5000){overflow++;return}events.push({kind,at:performance.now(),...extra})};
 const dialogs=node=>node instanceof Element?[...(node.matches('[role="dialog"]')?[node]:[]),...node.querySelectorAll('[role="dialog"]')]:[];
 const observer=new MutationObserver(records=>{
  for(const row of records){
   if(row.type==='attributes'&&row.target.matches('[role="dialog"]')){nodes.add(row.target);push('state',{oldState:row.oldValue,surface:surface(row.target)})}
   for(const n of row.addedNodes)for(const node of dialogs(n)){nodes.add(node);push('attach',{surface:surface(node)})}
   for(const n of row.removedNodes)for(const node of dialogs(n)){nodes.add(node);push('detach',{surface:surface(node)})}
  }
 });
 observer.observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['data-state'],attributeOldValue:true});
 for(const type of ['keydown','focusin','focusout'])document.addEventListener(type,event=>{
  const target=event.target instanceof Element?event.target:null;
  push(type,{trusted:event.isTrusted,key:event.key??null,ctrl:event.ctrlKey??false,meta:event.metaKey??false,
   target:target?.getAttribute('aria-label')??target?.textContent?.slice(0,80)??null,surfaces:[...nodes].map(surface)});
 },true);
 window.__agentAppDismissTimeline={snapshot:()=>({events:[...events],overflow}),mark:label=>push('mark',{label}),surface,
  dispose:()=>observer.disconnect()};
}

const dismissFlow = async (page,dir,name,condition,receipt) => {
 receipt.dismiss={progress:[],commandPalette:[],latency:"UNCHECKED"};
 receipt.dismiss.presentation=await page.evaluate(()=>{
  const names=new Set(),unreadable=[];
  const inspect=rules=>{for(const rule of rules){if(rule.type===CSSRule.KEYFRAMES_RULE)names.add(rule.name);if('cssRules' in rule)inspect(rule.cssRules)}};
  for(const sheet of document.styleSheets){try{inspect(sheet.cssRules)}catch(error){unreadable.push(sheet.href??'inline stylesheet')}}
  return {present:names.has('tangle-surface-present'),absent:names.has('tangle-surface-absent'),unreadable};
 });
 if(!receipt.dismiss.presentation.present||!receipt.dismiss.presentation.absent)throw new Error('Served catalog lacks Brand presence keyframes');
 const progress=label=>receipt.dismiss.progress.push(label);
 const action=page.getByRole('button',{name:'Open action dialog',exact:true});
 await action.click();await page.getByLabel('Dismiss draft').fill('Preserved dismissal draft');
 await page.getByLabel('Dismiss write in flight').check();
 await page.mouse.click(2,2);await page.keyboard.press('Escape');
 if(await page.getByRole('dialog').count()!==1)throw new Error('Busy action dialog dismissed');
 await page.screenshot({path:`${dir}/${name}-busy.png`,fullPage:false});
 await page.getByLabel('Dismiss write in flight').uncheck();await page.keyboard.press('Escape');
 await page.getByRole('dialog').waitFor({state:'detached'});
 await page.waitForFunction(()=>document.activeElement?.textContent==='Open action dialog');
 await action.click();
 if(await page.getByLabel('Dismiss draft').inputValue()!=='Preserved dismissal draft')throw new Error('Action dialog draft lost');
 await page.getByRole('button',{name:'Cancel dialog',exact:true}).click();
 await page.getByRole('dialog').waitFor({state:'detached'});
 await page.waitForFunction(()=>document.activeElement?.textContent==='Open action dialog');
 const opener=page.getByRole('button',{name:'Open command palette',exact:true});
 progress('ActionDialog busy/draft/close/focus assertions passed');
 const results=receipt.dismiss.commandPalette;
 for(const lostEvents of [false,true]){
  await opener.click();const content=page.getByRole('dialog',{name:'Dismiss command palette'});await content.waitFor();
  await page.getByRole('combobox',{name:'Dismiss command palette'}).waitFor();
  await content.evaluate((node,lostEvents)=>{
   const probe={node,trigger:document.querySelector('button:last-of-type'),events:[],lostEvents,roles:{}};
   probe.trigger=[...document.querySelectorAll('button')].find(n=>n.textContent==='Open command palette');
   const style=getComputedStyle(node);
   for(const key of ['--motion-dismiss','--motion-surface','--interaction-feedback-budget'])probe.roles[key]=style.getPropertyValue(key).trim();
   const listener=event=>{if(event.target===node){probe.events.push({type:event.type,withheld:lostEvents});if(lostEvents)event.stopImmediatePropagation()}};
   for(const type of ['animationend','animationcancel'])document.addEventListener(type,listener,true);
   probe.dispose=()=>{for(const type of ['animationend','animationcancel'])document.removeEventListener(type,listener,true)};
   window.__agentDismissProbe=probe;
  },lostEvents);
  await page.screenshot({path:`${dir}/${name}-${lostEvents?'lost-events':'normal'}-open.png`,fullPage:false});
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>{const p=window.__agentDismissProbe;return !p.node.isConnected&&document.activeElement===p.trigger&&document.body.style.pointerEvents!=='none'});
  results.push(await page.evaluate(()=>{const p=window.__agentDismissProbe;p.dispose();return {lostEvents:p.lostEvents,connected:p.node.isConnected,focusReturned:document.activeElement===p.trigger,pointerEvents:document.body.style.pointerEvents,events:p.events,roles:p.roles,latency:'UNCHECKED: no calibrated presented frames'}}));
 }
 await opener.click();const content=page.getByRole('dialog',{name:'Dismiss command palette'});await content.waitFor();
 await content.evaluate(node=>{window.__agentDismissReopen=node;window.__agentDismissReopenStart=performance.now();window.__agentAppDismissTimeline.mark('reopen-probe-start')});
 await page.keyboard.press('Escape');await page.keyboard.press('Control+k');
 await page.waitForFunction(()=>document.querySelector('[role="dialog"][data-state="open"]'));
 const reversal=await content.evaluate(node=>{
  const timeline=window.__agentAppDismissTimeline.snapshot();
  const old=window.__agentAppDismissTimeline.surface(window.__agentDismissReopen);
  const events=timeline.events.filter(row=>row.at>=window.__agentDismissReopenStart);
  const closed=events.find(row=>row.kind==='state'&&row.surface.token===old.token&&row.surface.state==='closed');
  const key=events.find(row=>row.kind==='keydown'&&row.trusted&&row.key?.toLowerCase()==='k'&&(row.ctrl||row.meta));
  const opened=events.find(row=>closed&&row.at>=closed.at&&(row.kind==='state'||row.kind==='attach')&&row.surface.state==='open');
  const deadline=closed?.surface.durationMs;
  const acceptedBeforeDeadline=!!(key&&opened&&closed&&Number.isFinite(deadline)&&deadline>0&&opened.at<closed.at+deadline&&timeline.overflow===0);
  return {sameNode:node===window.__agentDismissReopen,acceptedBeforeDeadline,closed,key,opened,
   status:acceptedBeforeDeadline?'OBSERVED':'UNCHECKED',reason:acceptedBeforeDeadline?'Actual open state observed before scoped retirement deadline':'Accepted in-flight reversal not established; late/unrecorded reopen is separate from continuity',timeline};
 });
 receipt.dismiss.reversal=reversal;
 if(reversal.acceptedBeforeDeadline&&!reversal.sameNode)throw new Error('Accepted pre-deadline reversal replaced the persistent surface');
 await page.getByRole('combobox',{name:'Dismiss command palette'}).fill('Reopened');
 await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'detached'});
 await page.waitForFunction(()=>document.activeElement?.textContent==='Open command palette'&&document.body.style.pointerEvents!=='none');
 await page.screenshot({path:`${dir}/${name}-closed.png`,fullPage:false});
 progress('CommandPalette close/reopen/cleanup/focus assertions passed');
 return {...receipt.dismiss,actionDialog:'busy outside/Escape blocked, draft retained, Cancel/Escape focus returned',reopen:{...reversal,condition,closed:true},sheet:'N/A: no shared Sheet consumer in fetched agent-app default/source',latency:'UNCHECKED'};
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
  // Keep static capture inside the recording viewport; full-page screenshots can expand/letterbox recorded frames.
  const context = await browser.newContext({viewport:{width,height},reducedMotion:condition==='reduced-motion'?'reduce':'no-preference',recordVideo:{dir,size:{width,height}}});
  if(phase==='dismiss')await context.addInitScript(installDismissTimeline);
  await context.tracing.start({screenshots:true,snapshots:true,sources:false});
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const errors=[],consoleErrors=[],requestFailures=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error'&&consoleErrors.length<100)consoleErrors.push(message.text())});
  page.on('requestfailed',request=>{if(requestFailures.length<100)requestFailures.push({url:request.url(),failure:request.failure()?.errorText})});
  const receipt={theme,width,height,condition,browser:browser.version(),errors,flow:'busy dialog/return, disclosure draft, grid edit, async action, settled terminal and synthetic API key',latency:'UNCHECKED: behavioral journeys are not2x40 latency batches or calibrated presented-frame measurements'};
  try {
   await page.goto(`http://localhost:6198/iframe.html?id=${storyId}&viewMode=story&globals=agentTheme:${theme}`,{waitUntil:'domcontentloaded',timeout:90000});
   await page.getByRole('heading',{name:phase==='dismiss'?'Application dialog dismissal':'Shared application controls'}).waitFor({timeout:120000});
   if(phase==='dismiss'){
    receipt.flow='Affected application Dialog dismissal/focus/reopen, including withheld CSS end/cancel events';
    receipt.dismiss=await dismissFlow(page,dir,name,condition,receipt);
    receipt.timeline=await page.evaluate(()=>window.__agentAppDismissTimeline.snapshot());
    receipt.instrument=await page.evaluate(()=>window.__agentAppInteractionEvidence?.snapshot()??{status:'UNCHECKED'});
    receipt.video=(await page.video().path()).split('/').pop();
    if(errors.length)throw new Error(`Page errors: ${errors.join('; ')}`);
    receipt.status='PASS';receipts.push(receipt);continue;
   }
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
   await page.screenshot({path:`${dir}/${name}.png`,fullPage:false});
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
   await page.screenshot({path:`${dir}/${name}-dialog.png`,fullPage:false});
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
   await page.screenshot({path:`${dir}/${name}-completed.png`,fullPage:false});
   if(phase==='after') {
    receipt.instrument=await page.evaluate(()=>window.__agentAppInteractionEvidence?.snapshot()??{status:'UNCHECKED',reason:'Catalog instrument unavailable'});
    receipt.calibration=await page.evaluate(()=>window.__agentAppInteractionEvidence?.calibrate()??{status:'UNCHECKED',reason:'Catalog instrument unavailable'});
   }
   receipt.environment=await page.evaluate(()=>({ua:navigator.userAgent,viewport:[innerWidth,innerHeight],dpr:devicePixelRatio,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,horizontalOverflow:document.documentElement.scrollWidth>innerWidth}));
   if(errors.length)throw new Error(`Page errors: ${errors.join('; ')}`);
   receipt.status='PASS';receipts.push(receipt);
  } catch(error) {
   if(phase==='dismiss')receipt.timeline=await page.evaluate(()=>window.__agentAppDismissTimeline?.snapshot()??{status:'UNKNOWN',reason:'Timeline unavailable'}).catch(problem=>({status:'UNKNOWN',reason:String(problem)}));
   receipt.instrument=await page.evaluate(()=>window.__agentAppInteractionEvidence?.snapshot()??{status:'UNCHECKED',reason:'Instrument unavailable on failed page'}).catch(problem=>({status:'UNCHECKED',reason:String(problem)}));
   receipt.status='FAIL';receipt.error=String(error);receipts.push(receipt);
   await Promise.allSettled([
    page.screenshot({path:`${dir}/${name}-failure.png`,fullPage:false,timeout:10000}),
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
