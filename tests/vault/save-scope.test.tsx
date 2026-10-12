// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { VaultPane } from '../../src/vault/VaultPane'
import type { VaultArtifactRenderProps, VaultDataPort, VaultMarkdownCodec } from '../../src/vault/contracts'
afterEach(cleanup)
const codec: VaultMarkdownCodec={parse:s=>s, serialize:s=>s as string}
function fixture(){
  const files={'a.md':'body A','b.md':'body B'};
  const port:VaultDataPort={listTree:async()=>Object.keys(files).map(path=>({name:path,path,type:'file'})),readFile:async path=>({path,content:files[path as keyof typeof files]}),writeFile:vi.fn(async()=>{}),createFile:async path=>path,deleteFile:async()=>{},listRevisions:async()=>[{id:'v0',savedAt:'2026-10-01T12:00:00Z',current:false}],readRevision:async()=> 'historic A'};
  let latest!:VaultArtifactRenderProps;
  const artifact=(p:VaultArtifactRenderProps)=>{latest=p;return <div>{String(p.richDraft)}</div>};
  const view=(canWrite=true)=><VaultPane port={port} codec={codec} selectedPath="a.md" canWrite={canWrite} renderArtifact={artifact}/>;
  const mounted=render(view());
  return {port,get:()=>latest,mounted,view};
}
async function ready(f:ReturnType<typeof fixture>){await waitFor(()=>expect(f.get()?.richDraft).toBe('body A'))}
describe('Vault retained write callbacks',()=>{
 it('refuses retained onSave after unmount',async()=>{const f=fixture();await ready(f);act(()=>f.get().onRichChange('unsaved'));const retained=f.get().onSave;f.mounted.unmount();act(()=>retained());expect(f.port.writeFile).not.toHaveBeenCalled()});
 it('refuses history restore after permission revocation while confirmation is open',async()=>{const f=fixture();await ready(f);fireEvent.click(screen.getByRole('button',{name:'History'}));fireEvent.click(await screen.findByRole('button',{name:'Restore this version'}));f.mounted.rerender(f.view(false));const confirm = screen.queryByRole('button',{name:'Restore version'});if(confirm)fireEvent.click(confirm);expect(confirm).toBeNull();expect(f.port.writeFile).not.toHaveBeenCalled()});
 it('does not let a retained rich callback overwrite source draft during source mode',async()=>{const f=fixture();await ready(f);const retained=f.get().onRichChange;fireEvent.click(screen.getByRole('button',{name:'Edit as source'}));fireEvent.change(screen.getByLabelText('Source editor'),{target:{value:'new source'}});act(()=>retained('stale rich callback'));fireEvent.click(screen.getByRole('button',{name:/^Save/}));expect(f.port.writeFile).toHaveBeenCalledWith('a.md','new source')});
})
