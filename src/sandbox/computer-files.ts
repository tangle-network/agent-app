/**
 * The files a computer step leaves in the workspace, and what the model may
 * truthfully tell the member about them.
 *
 * A box keeps workspace files under one directory; the app's Vault is a
 * different store, and a file the box agent saves proves nothing about it.
 * So when the step's run has ended, the step lists the box's tree, saves each
 * file changed since the run started through the app's `save`, and appends one receipt line to the
 * answer. That line is the only statement about Vault contents the model may
 * relay ({@link COMPUTER_FILES_GUIDANCE}). Legal learned this in production:
 * a child saved a file outside the Vault and the model said it was saved (#547).
 */
import type { SandboxInstance } from '@tangle-network/sandbox'
import { isWorkspaceFileExportable } from '../web/file-export'

/** One file the step wrote, at its path relative to the Vault root. */
export interface ComputerVaultFile {
  path: string
  content: string
  size: number
}

/** The app's Vault, as a computer step sees it. */
export interface ComputerVault {
  /** Absolute directory on the box that holds the workspace's files. */
  root: string
  /** Store one file the step wrote. A throw leaves it on the computer only, named in the receipt. */
  save(file: ComputerVaultFile, step: { executionId: string }): Promise<void>
  /** Why the Vault cannot hold this file, or null when it can. Default: text kinds up to 512 KB. */
  refuse?(path: string, size: number): string | null
  /** Most files one step saves. Default 20. */
  maxFiles?: number
}

/** Path relative to the root, mapped to the file's size and modification time. */
export type ComputerFileListing =
  | { succeeded: true; files: Record<string, { size: number; mtime: number }> }
  | { succeeded: false; error: string }

/** What one step saved, and what it left on the computer only (with the reason). */
export interface ComputerFileReceipt {
  checked: boolean
  saved: string[]
  computerOnly: Array<{ path: string; reason: string }>
  /** The receipt line appended to the step's answer. */
  text: string
}

/** Appended to the Router model's prompt whenever a computer step copies files into the Vault. */
export const COMPUTER_FILES_GUIDANCE =
  'A file the computer step made is in the workspace vault only when its reply lists the file after "Workspace vault"; ' +
  'for any other file it made, give the exact path from that reply and say it is only on the computer, ' +
  'and never call a file saved to the vault because the member asked for that.'

const DEFAULT_MAX_FILES = 20
const DEFAULT_MAX_BYTES = 512_000
const TEXT_FILE = /\.(md|markdown|txt|csv|tsv|json|jsonl|html?|xml|ya?ml|toml|svg|css|js|ts|py|sql)$/i

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300)
}

function defaultRefusal(path: string, size: number): string | null {
  if (!TEXT_FILE.test(path)) return 'not a text file the vault stores'
  if (size > DEFAULT_MAX_BYTES) return `larger than ${DEFAULT_MAX_BYTES / 1000} KB`
  return null
}

/** Appended to the task the box agent receives, so a member's relative path lands under the Vault root. */
export function computerFileContract(root: string, task: string): string {
  return `${task}\n\nWhere files go: the workspace's files live under ${root}. `
    + 'Save every file the member will open later there, at the path they gave relative to it '
    + `(proof/a.md is ${root}/proof/a.md), never in your working directory; keep scratch files elsewhere. `
    + 'End your reply with the exact absolute path of every file you saved.'
}

/** The box's tree under `root`. A tree the box cannot list completely is a failure, never a partial listing. */
export async function listComputerFiles(box: SandboxInstance, root: string): Promise<ComputerFileListing> {
  try {
    const tree = await box.fs.tree(root)
    if (tree.stats.truncated) return { succeeded: false, error: 'the workspace tree is too large to list completely' }
    // The sidecar reports the root and every path relative to the box workspace (`/home/agent`): for the root
    // `/home/agent/entities` it echoes root `entities` and file `entities/proof/a.md`. Strip the echoed root whether it
    // arrives relative or absolute; `.` means the paths are already relative (Legal #551 found the doubled path).
    const echoed = tree.root.replace(/\/+$/, '')
    const prefixes = [`${root.replace(/\/+$/, '')}/`]
    if (echoed && echoed !== '.') prefixes.unshift(`${echoed}/`)
    const files: Record<string, { size: number; mtime: number }> = {}
    for (const file of tree.files) {
      const prefix = prefixes.find(candidate => file.path.startsWith(candidate))
      files[prefix ? file.path.slice(prefix.length) : file.path.replace(/^\.\//, '')] = { size: file.size, mtime: file.mtime }
    }
    return { succeeded: true, files }
  } catch (error) {
    return { succeeded: false, error: message(error) }
  }
}

// Filesystem mtimes are coarser than the runtime's clock; a file written in the run's first second still counts.
const MTIME_TOLERANCE_MS = 1_000

/**
 * Save what the step wrote into the Vault and return its receipt. `since` is when the step's run started, from the
 * runtime's execution ledger (`session.runs()`): the box's own clock, so the files it changed since then are this
 * step's, with no listing kept from before the send. A live call, a reattached call and a later sweep each copy the
 * same files; `vault.save` must be idempotent for a path and content.
 */
export async function saveComputerFiles(input: {
  box: SandboxInstance
  vault: ComputerVault
  since: number | undefined
  executionId: string
}): Promise<ComputerFileReceipt> {
  const { box, vault, since, executionId } = input
  const root = vault.root.replace(/\/+$/, '')
  const unchecked = (error: string): ComputerFileReceipt => {
    console.warn(JSON.stringify({ event: 'agent_app_computer_files_unchecked', executionId, error }))
    return { checked: false, saved: [], computerOnly: [],
      text: 'Workspace vault: the app could not check which files this step saved, so none is confirmed to be in it.' }
  }
  if (since === undefined || !Number.isFinite(since)) return unchecked('the runtime ledger did not report when the step started')
  const after = await listComputerFiles(box, root)
  if (!after.succeeded) return unchecked(after.error)

  const maxFiles = vault.maxFiles ?? DEFAULT_MAX_FILES
  const refuse = vault.refuse ?? defaultRefusal
  const saved: string[] = []
  const computerOnly: Array<{ path: string; reason: string }> = []
  for (const [path, file] of Object.entries(after.files)) {
    if (file.mtime < since - MTIME_TOLERANCE_MS) continue
    if (!isWorkspaceFileExportable(path)) continue
    const refusal = saved.length + computerOnly.length >= maxFiles ? `more than ${maxFiles} files changed` : refuse(path, file.size)
    if (refusal) {
      computerOnly.push({ path, reason: refusal })
      continue
    }
    try {
      await vault.save({ path, content: await box.fs.read(`${root}/${path}`), size: file.size }, { executionId })
      saved.push(path)
    } catch (error) {
      console.error(JSON.stringify({ event: 'agent_app_computer_file_not_saved', executionId, path, error: message(error) }))
      computerOnly.push({ path, reason: 'saving it to the vault failed' })
    }
  }
  console.info(JSON.stringify({ event: 'agent_app_computer_files', executionId, saved: saved.length, computerOnly: computerOnly.length }))

  const lines: string[] = []
  if (saved.length > 0) lines.push(`Workspace vault: the app saved ${saved.join(', ')} into it after this step.`)
  if (computerOnly.length > 0) {
    lines.push(`Only on the computer, not in the workspace vault: ${computerOnly.map(file => `${root}/${file.path} (${file.reason})`).join('; ')}.`)
  }
  if (lines.length === 0) lines.push(`Workspace vault: nothing the computer wrote under ${root} in this step was saved into it.`)
  return { checked: true, saved, computerOnly, text: lines.join('\n') }
}
