/**
 * Fuses several `TimelineCommand`s into one undo step so a single gesture
 * (multi-select delete, drop that creates a track and places a clip) never
 * fragments the history. Execute runs in order; undo runs in strict reverse so
 * intermediate states reconstruct exactly.
 */

import type { TimelineCommand } from '../contracts'

export function compositeCommand(label: string, commands: TimelineCommand[]): TimelineCommand {
  if (commands.length === 0) throw new Error('compositeCommand requires at least one command')
  return {
    label,
    execute: (state) => commands.reduce((acc, command) => command.execute(acc), state),
    undo: (state) => [...commands].reverse().reduce((acc, command) => command.undo(acc), state),
    operations: () => commands.flatMap((command) => command.operations()),
    inverseOperations: () => [...commands].reverse().flatMap((command) => command.inverseOperations()),
  }
}
