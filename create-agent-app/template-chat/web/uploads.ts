import { useEffect, useRef, useState } from 'react'
import type { ComposerFile, ComposerFilePart } from '@tangle-network/agent-app/web-react'
import { json } from './api'

// Product adapter for createUploadRoute's inline/sandbox parts contract.
// useComposerAttachments is for a DIFFERENT, durable-store upload contract.
// Keep the server response verbatim; do not turn a data: URI into a store path.
export function useInlineUploads() {
  const [files, setFiles] = useState<ComposerFile[]>([])
  const requests = useRef(new Map<string, { file: File; controller: AbortController }>())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; for (const { controller } of requests.current.values()) controller.abort() }
  }, [])

  async function upload(id: string, file: File) {
    const controller = new AbortController()
    requests.current.set(id, { file, controller })
    setFiles((items) => items.map((item) => item.id === id ? { ...item, status: 'uploading', errorMessage: undefined } : item))
    try {
      const body = new FormData()
      body.append('files', file)
      const result = await json<{ files: Array<{ part: ComposerFilePart }> }>('/api/chat/upload', { method: 'POST', body, signal: controller.signal })
      const part = result.files[0]?.part
      if (!part || !['image', 'file'].includes(part.type) || (!part.url && !part.path)) throw new Error('Upload returned no usable file part')
      if (!controller.signal.aborted && mounted.current) {
        setFiles((items) => items.map((item) => item.id === id ? { ...item, status: 'ready', part } : item))
      }
    } catch (error) {
      if (!controller.signal.aborted && mounted.current) {
        setFiles((items) => items.map((item) => item.id === id ? { ...item, status: 'error', errorMessage: error instanceof Error ? error.message : 'Upload failed' } : item))
      }
    }
  }
  return {
    files,
    add(selected: FileList | File[]) {
      for (const file of selected) {
        const id = crypto.randomUUID()
        setFiles((items) => [...items, { id, name: file.name, size: file.size, kind: 'file', status: 'uploading' }])
        void upload(id, file)
      }
    },
    retry(id: string) { const entry = requests.current.get(id); if (entry) void upload(id, entry.file) },
    remove(id: string) {
      requests.current.get(id)?.controller.abort(); requests.current.delete(id)
      setFiles((items) => items.filter((item) => item.id !== id))
    },
    clear() {
      for (const { controller } of requests.current.values()) controller.abort()
      requests.current.clear(); setFiles([])
    },
  }
}
