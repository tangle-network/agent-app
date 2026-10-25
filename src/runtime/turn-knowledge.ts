/**
 * Knowledge in every turn: the index of an app's knowledge files, the full
 * text of the small ones, and the rule that keeps answers on them.
 *
 * Measured on Hospitality production: a Router turn that had to
 * discover files through list/read tools answered 17/17 correctly but needed
 * 3 tool calls (first words 12-17 s), and a turn that skipped the tools
 * answered from model defaults ("checkout 11:00" when the file said 12 pm).
 * Putting the text in the prompt removes both failure modes.
 */
/** The fields read from an agent-runtime workspace-store entry; structural so older runtimes still type-check. */
interface KnowledgeEntry { path: string; kind: string; content?: string; bytes?: { size: number } }

/** One knowledge file a turn carries; `text` is null when it is too large or not readable here. */
export interface TurnKnowledgeFile {
  path: string
  size: number
  text: string | null
}

export interface TurnKnowledgeBudget {
  /** Files at most this many bytes have their text included. Default 8 000. */
  fileBytes?: number
  /** Total text bytes across files. Default 16 000. */
  textBytes?: number
  /** Most files listed. Default 60. */
  maxFiles?: number
}

const DEFAULT_FILE_BYTES = 8_000
const DEFAULT_TEXT_BYTES = 16_000
const DEFAULT_MAX_FILES = 60

/** Apply the byte budget in path order: small files keep their text until the total is spent. */
export function budgetTurnKnowledge(files: readonly TurnKnowledgeFile[], budget: TurnKnowledgeBudget = {}): TurnKnowledgeFile[] {
  const fileBytes = budget.fileBytes ?? DEFAULT_FILE_BYTES
  let remaining = budget.textBytes ?? DEFAULT_TEXT_BYTES
  return [...files].sort((a, b) => a.path.localeCompare(b.path)).slice(0, budget.maxFiles ?? DEFAULT_MAX_FILES)
    .map(file => {
      const fits = file.text !== null && file.size <= fileBytes && file.size <= remaining
      if (fits) remaining -= file.size
      return { path: file.path, size: file.size, text: fits ? file.text : null }
    })
}

/**
 * The prompt lines for a turn's knowledge. `readTool` names the tool that
 * opens a listed file whose text is not shown; without one, such a file is
 * listed by name only.
 */
export function turnKnowledgeInstructions(files: readonly TurnKnowledgeFile[], options: { readTool?: string } = {}): string[] {
  const read = options.readTool
  return [
    'Answer questions about this business or its work (hours, times, policies, codes, passwords, prices, contacts, amenities, procedures) only from the knowledge in these instructions, the knowledge files below, or a tool result. Never give a typical or assumed value, and do not say something is absent unless a source says so.' +
      (read ? ` When a listed file without its text may cover the question, read it with ${read} before answering.` : '') +
      ' When nothing covers it, say you do not have that information and offer to ask the owner.' +
      ' When two sources disagree, give each value with the source that states it and ask the owner which is current; never pick one silently.',
    ...files.map(file => file.text !== null ? `Knowledge file ${file.path}:\n${file.text}`
      : `Knowledge file ${file.path} (${file.size} bytes, text not shown)${read ? `: read it with ${read} when the question may be covered by it.` : '.'}`),
    // The disagree rule above, read before the files, named a conflict in 10 of 20 bench turns
    // (hospitality, 3 of 5 in production); repeated after the files as a check it named 20 of 20,
    // and 10 of 10 single-file answers stayed unchanged (gemini-3.5-flash-lite, 2026-10-12,
    // hospitality-agent #441).
    ...(files.length > 1 ? ['Before answering from these files, check every file that states the asked fact. When they state different values, give each value with its file name and ask the owner which is current.'] : []),
  ]
}

/** A workspace store's knowledge files (kind `file` under `prefix`) as turn knowledge, within the budget. */
export async function workspaceKnowledgeForTurn(
  store: { list(workspaceId: string, prefix: string): Promise<readonly KnowledgeEntry[]> },
  workspaceId: string,
  options: TurnKnowledgeBudget & { prefix?: string } = {},
): Promise<TurnKnowledgeFile[]> {
  const entries = await store.list(workspaceId, options.prefix ?? '/files/')
  return budgetTurnKnowledge(entries.filter(entry => entry.kind === 'file').map(entry => ({
    path: entry.path,
    size: entry.content !== undefined ? new TextEncoder().encode(entry.content).byteLength : entry.bytes?.size ?? 0,
    text: entry.content ?? null,
  })), options)
}
