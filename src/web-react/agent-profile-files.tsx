/**
 * Drop or choose text files to add to the profile as resource files. Each file
 * is read in the browser and stored inline, with per-file progress and a clear
 * reason for any file that is refused (type, size, count, encoding, or a path
 * already in use). The drop target and the progress list are the shared
 * `SidebarDropZone` and `UploadProgress` primitives.
 */
import { useRef, useState, type ReactNode } from 'react'
import { Button } from '@tangle-network/sandbox-ui/primitives'
import { SidebarDropZone, UploadProgress, type UploadFile } from '@tangle-network/ui/primitives'
import { filterAcceptedFiles } from './composer-file-accept'
import { formText } from './agent-profile-form-kit'

export interface ResourceFileLimits {
  /** Accepted types, in `<input accept>` grammar. Defaults to Markdown, text, and JSON. */
  accept?: readonly string[]
  /** Largest file in bytes. Defaults to 256 KiB. */
  maxFileBytes?: number
  /** Most resource files in the profile. Defaults to 50. */
  maxFiles?: number
}

const DEFAULT_RESOURCE_FILE_ACCEPT = ['.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.csv'] as const

interface ReadFile {
  name: string
  content: string
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** A file name safe to use as one path segment. */
function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  return base.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '').replace(/^\.+/, '') || 'file'
}

function readText(file: File, onProgress: (percent: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onprogress = event => { if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100)) }
    reader.onerror = () => reject(new Error('The browser could not read this file.'))
    reader.onload = () => {
      const buffer = reader.result
      if (!(buffer instanceof ArrayBuffer)) { reject(new Error('The browser could not read this file.')); return }
      try { resolve(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) } catch {
        reject(new Error('This is not a text file. Upload UTF-8 text, Markdown, or JSON.'))
      }
    }
    reader.readAsArrayBuffer(file)
  })
}

export interface ResourceFileDropProps {
  /** Paths already in the profile, for conflict checks. */
  existingPaths: readonly string[]
  /** Folder new files land in, for example `reference/`. */
  pathPrefix?: string
  limits?: ResourceFileLimits
  disabled?: boolean
  /** Add the read files. Returns the reason the profile rejected them, or null. */
  onAdd: (files: { path: string; file: ReadFile }[]) => string | null
  /** More add actions shown beside "Choose files". */
  actions?: ReactNode
}

/** The drop target, file chooser, and progress list for resource files. */
export function ResourceFileDrop({ existingPaths, pathPrefix = '', limits, disabled = false, onAdd, actions }: ResourceFileDropProps) {
  const [uploads, setUploads] = useState<UploadFile[]>([])
  const input = useRef<HTMLInputElement>(null)
  const accept = (limits?.accept ?? DEFAULT_RESOURCE_FILE_ACCEPT).join(',')
  const maxFileBytes = limits?.maxFileBytes ?? 256 * 1024
  const maxFiles = limits?.maxFiles ?? 50
  const types = (limits?.accept ?? DEFAULT_RESOURCE_FILE_ACCEPT).map(type => type.replace(/^\./, '').toUpperCase())
  const typeList = types.length > 1 ? `${types.slice(0, -1).join(', ')} or ${types[types.length - 1]}` : types[0]

  function update(id: string, change: Partial<UploadFile>) {
    setUploads(current => current.map(item => item.id === id ? { ...item, ...change } : item))
  }

  async function receive(list: File[] | FileList) {
    if (disabled) return
    const files = Array.from(list)
    if (!files.length) return
    const { rejected } = filterAcceptedFiles(files, accept)
    const batch: UploadFile[] = []
    const taken = new Set(existingPaths)
    let room = maxFiles - existingPaths.length
    const work: { id: string; file: File; path: string }[] = []
    for (const file of files) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const base: UploadFile = { id, name: file.name, size: file.size, status: 'pending' }
      const path = pathPrefix + safeFileName(file.name)
      let error: string | null = null
      if (rejected.some(item => item.file === file)) error = `Only ${typeList} files can be added.`
      else if (file.size > maxFileBytes) error = `This file is ${formatBytes(file.size)}. Files can be up to ${formatBytes(maxFileBytes)}.`
      else if (file.size === 0) error = 'This file is empty.'
      else if (taken.has(path)) error = `${path} is already in the profile. Remove it first or rename the file.`
      else if (room <= 0) error = `The profile can hold ${maxFiles} files. Remove one to add another.`
      if (error) { batch.push({ ...base, status: 'error', error }); continue }
      taken.add(path)
      room--
      batch.push(base)
      work.push({ id, file, path })
    }
    setUploads(current => [...current.filter(item => item.status !== 'complete'), ...batch])
    const read: { id: string; path: string; file: ReadFile }[] = []
    for (const item of work) {
      update(item.id, { status: 'uploading', progress: 0 })
      try {
        const content = await readText(item.file, progress => update(item.id, { progress }))
        read.push({ id: item.id, path: item.path, file: { name: safeFileName(item.file.name), content } })
        update(item.id, { progress: 100 })
      } catch (cause) {
        update(item.id, { status: 'error', error: cause instanceof Error ? cause.message : 'The file could not be read.' })
      }
    }
    if (!read.length) return
    const refused = onAdd(read.map(({ path, file }) => ({ path, file })))
    for (const item of read) {
      update(item.id, refused ? { status: 'error', error: refused } : { status: 'complete', progress: 100 })
    }
  }

  return <div className="space-y-3">
    <SidebarDropZone persistent disabled={disabled} onDrop={files => void receive(files)}
      title="Drop files here"
      description={`${typeList} up to ${formatBytes(maxFileBytes)} each`}
      // The primitive's own copy is 12px and 10px; the form uses one 14px size.
      className="[&_p]:text-sm [&_p]:leading-6 focus-within:border-[var(--focus-border)]" />
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" size="compact" variant="outline" disabled={disabled} onClick={() => input.current?.click()}>Choose files</Button>
      {actions}
      <input ref={input} type="file" multiple accept={accept} className="sr-only" tabIndex={-1} aria-hidden="true"
        onChange={event => { const files = event.target.files; if (files) void receive(files); event.target.value = '' }} />
      {uploads.length > 0 && <Button type="button" size="compact" variant="ghost" onClick={() => setUploads([])}>Clear list</Button>}
    </div>
    {uploads.length > 0 && <div aria-live="polite">
      <UploadProgress files={uploads} onRemove={id => setUploads(current => current.filter(item => item.id !== id))}
        // The primitive sets size and error text at 12px; keep them at the form's 14px.
        className="[&_.text-xs]:text-sm" />
    </div>}
    {uploads.some(item => item.status === 'error') && <p className={formText.muted}>Files with an error were not added.</p>}
  </div>
}
