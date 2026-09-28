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
