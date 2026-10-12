// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FileArtifactPane } from '@tangle-network/sandbox-ui/files'
import { VaultPane } from '../../src/vault/VaultPane'
import type { VaultArtifactRenderProps, VaultDataPort, VaultMarkdownCodec } from '../../src/vault/contracts'

afterEach(cleanup)
const codec: VaultMarkdownCodec = {
  parse(raw) { const [prefix, body = ''] = raw.split('\n---\n'); return { prefix, body } },
  serialize(parts) { const p = parts as {prefix:string;body:string}; return `${p.prefix}\n---\n${p.body}` },
}
const body = (parts: unknown) => typeof parts === 'string' ? parts : (parts as {body?:string})?.body ?? ''
const deferred = () => { let resolve!: () => void; let reject!: (e: Error) => void; const promise = new Promise<void>((a,b)=>{resolve=a;reject=b}); return {promise,resolve,reject} }
function fixture(options: {codec?: VaultMarkdownCodec; canWrite?: boolean; write?: (path:string,content:string)=>Promise<void>} = {}) {
  const files: Record<string,string> = { 'a.md': options.codec ? 'title: A\n---\nbody A' : 'body A', 'b.md':'body B' }
  const port: VaultDataPort = {
    listTree: async()=>Object.keys(files).map(path=>({name:path,path,type:'file' as const})),
    readFile: async path=>({path,content:files[path] ?? ""}),
    writeFile: vi.fn(async (path,content)=>{await options.write?.(path,content); files[path]=content}),
    createFile: async path=>path, deleteFile: async()=>{},
  }
  let latest!: VaultArtifactRenderProps
  const artifact = (p: VaultArtifactRenderProps) => {
    latest = p
    if (!p.file) return null
    return <FileArtifactPane filename={p.file.path} content={body(p.richDraft)} editor={{enabled:true,backend:'local',savedContent:body(p.savedRichDraft),saving:p.saving,readOnly:!p.canWrite,onSave:()=>p.onSave()}} />
  }
  const view = (canWrite=options.canWrite ?? true)=> <VaultPane port={port} codec={options.codec} selectedPath="a.md" canWrite={canWrite} renderArtifact={artifact} />
  const mounted = render(view())
  return { port, files, get:()=>latest, mounted, view, artifact }
}
async function ready(f: ReturnType<typeof fixture>) { await waitFor(()=>expect(body(f.get()?.richDraft)).toBe('body A')) }
async function edit(f: ReturnType<typeof fixture>, text:string) { await act(async()=>{ const p=f.get();p.onRichChange(typeof p.richDraft==='string'?text:{...(p.richDraft as object),body:text}) }) }

describe('Vault persisted baseline and save ownership',()=>{
  it('keeps the codec-parsed saved baseline independent from the live draft in the real file editor',async()=>{
    const f=fixture({codec});await ready(f)
    expect(f.get().savedRichDraft).toEqual({prefix:'title: A',body:'body A'})
    await edit(f,'new body')
    expect(f.get().savedRichDraft).toEqual({prefix:'title: A',body:'body A'})
    expect((screen.getByRole('button',{name:'Save changes'}) as HTMLButtonElement).disabled).toBe(false)
    await edit(f,'body A')
    expect(f.get().dirty).toBe(false)
    const save=screen.queryByRole('button',{name:'Save changes'}) as HTMLButtonElement|null
    expect(save === null || save.disabled).toBe(true)
  })
  it('admits one write for repeated callbacks before a render and while pending',async()=>{
    const d=deferred();const f=fixture({write:()=>d.promise});await ready(f);await edit(f,'one')
    act(()=>{f.get().onSave();f.get().onSave()})
    expect(f.port.writeFile).toHaveBeenCalledTimes(1)
    act(()=>f.get().onSave());expect(f.port.writeFile).toHaveBeenCalledTimes(1)
    await act(async()=>d.resolve());await waitFor(()=>expect(f.get().saving).toBe(false))
  })
  it('preserves newer edits when an older successful save finishes',async()=>{
    const d=deferred();const f=fixture({write:()=>d.promise});await ready(f);await edit(f,'first')
    act(()=>f.get().onSave());await edit(f,'second')
    await act(async()=>d.resolve())
    await waitFor(()=>expect(f.get().saving).toBe(false))
    expect(f.files['a.md']).toBe('first');expect(f.get().file?.content).toBe('first')
    expect(body(f.get().savedRichDraft)).toBe('first');expect(body(f.get().richDraft)).toBe('second');expect(f.get().dirty).toBe(true)
  })
  it('retains the draft and persisted baseline after a failure and retries it',async()=>{
    let fail=true;const f=fixture({write:async()=>{if(fail)throw new Error('write refused')}});await ready(f);await edit(f,'retry me')
    act(()=>f.get().onSave());await screen.findByText('write refused')
    expect(body(f.get().richDraft)).toBe('retry me');expect(body(f.get().savedRichDraft)).toBe('body A');expect(f.get().dirty).toBe(true)
    fail=false;act(()=>f.get().onSave());await waitFor(()=>expect(f.get().dirty).toBe(false))
    expect(f.files['a.md']).toBe('retry me');expect(f.port.writeFile).toHaveBeenCalledTimes(2)
  })
  it('refuses host writes after permission is revoked, including a retained callback',async()=>{
    const f=fixture();await ready(f);await edit(f,'draft');const stale=f.get().onSave
    f.mounted.rerender(f.view(false));act(()=>stale())
    expect(f.port.writeFile).not.toHaveBeenCalled()
  })
  it('refuses saving a clean file',async()=>{const f=fixture();await ready(f);act(()=>f.get().onSave());expect(f.port.writeFile).not.toHaveBeenCalled()})
  it('does not restore an old file when its write resolves after selection changes',async()=>{
    const d=deferred();const f=fixture({write:()=>d.promise});await ready(f);await edit(f,'old write');act(()=>f.get().onSave())
    f.mounted.rerender(<VaultPane port={f.port} selectedPath="b.md" renderArtifact={f.artifact} />)
    await act(async()=>d.resolve())
    await waitFor(()=>expect(f.get().file?.path).toBe('b.md'))
    expect(body(f.get().richDraft)).toBe('body B');expect(f.get().dirty).toBe(false)
  })
  it('saves the current mode after source/rich/source conversion, including codec normalization',async()=>{
    const normalizingCodec: VaultMarkdownCodec = {
      // Deliberately violates the documented exact-inverse codec rule to prove
      // the save still matches the active editor, never its stale prior mode.
      parse(raw) { return raw.trim() }, serialize(parts) { return String(parts) },
    }
    const f=fixture({codec:normalizingCodec})
    await waitFor(()=>expect(f.get()?.file?.path).toBe('a.md'))
    fireEvent.click(screen.getByRole('button',{name:'Edit as source'}))
    fireEvent.change(screen.getByRole('textbox',{name:'Source editor'}),{target:{value:'  source edit  '}})
    fireEvent.click(screen.getByRole('button',{name:'Edit as rich text'}))
    expect(body(f.get().richDraft)).toBe('source edit')
    fireEvent.click(screen.getByRole('button',{name:'Edit as source'}))
    expect((screen.getByRole('textbox',{name:'Source editor'}) as HTMLTextAreaElement).value).toBe('source edit')
    fireEvent.click(screen.getByRole('button',{name:'Save'}))
    await waitFor(()=>expect(f.files['a.md']).toBe('source edit'))
  })
  it('retains the right baseline when reopening a different file with identical content',async()=>{
    const f=fixture();f.files['b.md']='body A';await ready(f);await edit(f,'first');act(()=>f.get().onSave())
    await waitFor(()=>expect(f.get().dirty).toBe(false))
    f.files['b.md']='first'
    f.mounted.rerender(<VaultPane port={f.port} selectedPath="b.md" renderArtifact={f.artifact} />)
    await waitFor(()=>expect(f.get().file?.path).toBe('b.md'))
    expect(body(f.get().savedRichDraft)).toBe('first')
    await edit(f,'B edit');act(()=>f.get().onSave())
    await waitFor(()=>expect(f.files['b.md']).toBe('B edit'))
    expect(f.files['a.md']).toBe('first')
  })

})
