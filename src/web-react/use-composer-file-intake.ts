/** One accepted-file path for file pickers, clipboard pastes, and drops. */
import { useCallback, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent } from 'react'
import { filterAcceptedFiles, renamePastedImages } from './composer-file-accept'
import type { ChatComposerProps } from './chat-composer-types'

type ComposerFileIntakeOptions = Pick<ChatComposerProps, 'onAttach' | 'onAttachFolder' | 'accept' | 'onRejectFiles'> & {
  pendingFiles: NonNullable<ChatComposerProps['pendingFiles']>
}

export function useComposerFileIntake({ onAttach, onAttachFolder, accept, onRejectFiles, pendingFiles }: ComposerFileIntakeOptions) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const dragDepth = useRef(0)
  // Counts every clipboard image this composer has renamed, so two pastes of
  // the same bitmap do not both arrive as `image.png`.
  const pastedImageCount = useRef(0)

  // Every route a file can arrive by ends here: apply `accept`, report what it
  // removed, and hand `onAttach` only what passed. A batch the filter left
  // untouched is forwarded as the browser's own `FileList`; one it changed is
  // rebuilt, since `onAttach` takes a `FileList` and only a `DataTransfer` can
  // produce one.
  const deliverFiles = useCallback(
    (files: File[], original: FileList) => {
      if (!onAttach || files.length === 0) return
      const { accepted, rejected } = filterAcceptedFiles(files, accept)
      if (rejected.length > 0) onRejectFiles?.(rejected)
      if (accepted.length === 0) return
      const unchanged =
        accepted.length === original.length && accepted.every((file, i) => file === original[i])
      if (unchanged) {
        onAttach(original)
        return
      }
      const transfer = new DataTransfer()
      for (const file of accepted) transfer.items.add(file)
      onAttach(transfer.files)
    },
    [onAttach, onRejectFiles, accept],
  )

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    // Re-filter: a picker dialog lets the user override `accept` with
    // "All Files", so the attribute alone does not hold the gate.
    if (e.target.files?.length) deliverFiles(Array.from(e.target.files), e.target.files)
    e.target.value = ''
  }

  // One paste core for both input modes. Returns true when files were the
  // payload — the caller then suppresses the default text paste even when
  // every file is refused, so a rejection never half-pastes stray text.
  // The staged names go in alongside the count: the queue is the host's and
  // can outlive this mount, so the count alone could hand the next paste a
  // name the queue already holds.
  const ingestPastedFiles = (clipboardFiles: FileList): boolean => {
    if (!onAttach || clipboardFiles.length === 0) return false
    const { files, nextIndex } = renamePastedImages(
      Array.from(clipboardFiles),
      pastedImageCount.current,
      pendingFiles.map((f) => f.name),
    )
    pastedImageCount.current = nextIndex
    deliverFiles(files, clipboardFiles)
    return true
  }

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const clipboardFiles = e.clipboardData?.files
    if (!clipboardFiles || clipboardFiles.length === 0) return
    if (ingestPastedFiles(clipboardFiles)) e.preventDefault()
  }

  const handleFolderChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) (onAttachFolder ?? onAttach)?.(e.target.files)
    e.target.value = ''
  }

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragDepth.current++
    if (e.dataTransfer?.types.includes('Files')) setDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragDepth.current--
    if (dragDepth.current <= 0) {
      dragDepth.current = 0
      setDragOver(false)
    }
  }, [])

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragDepth.current = 0
      setDragOver(false)
      const files = e.dataTransfer?.files
      if (files?.length) deliverFiles(Array.from(files), files)
    },
    [deliverFiles],
  )

  return { fileInputRef, folderInputRef, dragOver, handleFileChange, handleFolderChange, handlePaste, ingestPastedFiles, handleDragEnter, handleDragLeave, handleDragOver, handleDrop }
}
