# Open files from outside the Vault

Use the pane's handle for artifact links and other file controls outside its tree.
The pane confirms unsaved changes before it reports a new selection.
Cancel preserves the current draft.

```tsx
import { Suspense, useRef, useState } from 'react'
import {
  VaultPaneLazy,
  type VaultPaneHandle,
  type VaultPaneProps,
} from '@tangle-network/agent-app/vault/lazy'

type Props = Pick<VaultPaneProps, 'port' | 'renderTree' | 'renderArtifact'> & {
  artifactPath: string
}

export function ProjectVault({ artifactPath, ...props }: Props) {
  const pane = useRef<VaultPaneHandle>(null)
  const [path, setPath] = useState<string | null>(null)

  return (
    <>
      <button type="button" onClick={() => pane.current?.openFile(artifactPath)}>
        Open artifact
      </button>
      <Suspense fallback={<p>Loading files…</p>}>
        <VaultPaneLazy
          {...props}
          ref={pane}
          selectedPath={path}
          onSelectedPathChange={setPath}
        />
      </Suspense>
    </>
  )
}
```

The direct `@tangle-network/agent-app/vault` entrypoint exposes the same handle on `VaultPane`.
Use `onSelectedPathChange` to retain committed selection in product state or a route.
Do not call that notification callback to request navigation from another control.

A requested file can be absent from the current tree.
The pane passes its path to `VaultDataPort.readFile`; the port owns path validation, authorization, and missing-file responses.
Read failures remain visible with the pane's existing retry action.
Known directory rows retain their existing folder behavior.

This handle guards file selection within the mounted pane.
The host product must guard page navigation through its router.
Use the artifact renderer's `dirty` flag to track unsaved work.

## Connect a document editor to persistence

`VaultPane` owns the saved baseline, dirty state, and write admission. A rich
artifact renderer must keep its live draft separate from that baseline. With the
identity codec, forward `richDraft` as `FileArtifactPane.content` and
`savedRichDraft` as `editor.savedContent`; also forward `saving`:

```tsx
renderArtifact={({ file, richDraft, savedRichDraft, canWrite, revision, saving, onRichChange, onSave }) => file && (
  <FileArtifactPane
    key={file.path}
    filename={file.path}
    content={String(richDraft ?? '')}
    editor={{
      enabled: canWrite && !revision,
      savedContent: String(savedRichDraft ?? file.content),
      saving,
      backend: 'local',
      onChange: onRichChange,
      onSave,
    }}
  />
)}
```

Import `FileArtifactPane` from `@tangle-network/sandbox-ui/files`. For a codec
that separates frontmatter from the body, extract the body from **both**
`richDraft` and `savedRichDraft`; both have been parsed by the same codec. Do not
compare a rendered body to raw frontmatter or use the live draft as the saved
baseline. `savedRichDraft` is optional in the structural type for compatibility
with existing test doubles; `VaultPane` supplies it whenever a file is loaded.

A custom editor may use `dirty` and `saving` directly. Disable its Save control
when clean, saving, read-only, or viewing a revision. `onSave` remains a void
notification: observe `saving`, `dirty`, and the pane's error presentation rather
than assuming a returned promise means persistence succeeded. The pane admits
only one write at a time, retains failed drafts for retry, and preserves edits
made while an older save is pending. It also rejects callbacks retained after
unmount, file/permission changes, or switching away from their editor mode.
The product's data port still owns server-side authorization and conflict checks.
