import assert from 'node:assert/strict'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const require = createRequire(pathToFileURL(process.cwd() + '/package.json'))
const { Miniflare, convertV4MiniflareOptions } = createRequire(require.resolve('wrangler/package.json'))('miniflare')
const emitted = stripTypeScriptTypes(readFileSync('src/platform/router-connections.ts', 'utf8'))
const worker = new Miniflare(convertV4MiniflareOptions({ workers:[
  {name:'app', modules:true, compatibilityDate:'2026-10-01', outboundService:'inventory', script:emitted + `
    export default {async fetch(req) {
      const key = new URL(req.url).searchParams.has('moved') ? 'redirect-fixture' : 'connected-fixture';
      const client = createRouterConnections({baseUrl:'https://router.example.test/v1',bearer:key});
      try {const rows=await client.list();return Response.json({names:rows.map(row=>row.displayName)});}
      catch(error){return Response.json({error:error.message},{status:502});}
    }};`},
  {name:'inventory', modules:true, compatibilityDate:'2026-10-01', script:`export default {fetch(req) {
    const url=new URL(req.url);
    if(url.pathname!='/v1/byok')return new Response('wrong URL',{status:500});
    if(req.headers.get('Authorization')==='Bearer redirect-fixture')return Response.redirect('https://untrusted.example.test/elsewhere',307);
    return Response.json({data:[{id:'6695ffb4-c53e-44f4-81ae-85bfde17cbd2',provider:'zai-coding-plan',name:'Visible in Workers',allowed_models:['zai/glm-5.4']}],total_count:1});
  }}`}
]}))
try {
  const ok=await worker.dispatchFetch('https://app.example.test/');
  assert.equal(ok.status,200);assert.deepEqual(await ok.json(),{names:['Visible in Workers']});
  const refused=await worker.dispatchFetch('https://app.example.test/?moved');
  assert.equal(refused.status,502);assert.match((await refused.json()).error,/HTTP 307/);
  console.log('PASS real workerd linked-connection GET and manual cross-origin 307 refusal')
} finally {await worker.dispose()}
