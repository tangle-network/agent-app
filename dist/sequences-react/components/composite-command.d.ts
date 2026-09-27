/**
 * Fuses several `TimelineCommand`s into one undo step so a single gesture
 * (multi-select delete, drop that creates a track and places a clip) never
 * fragments the history. Execute runs in order; undo runs in strict reverse so
 * intermediate states reconstruct exactly.
 */
import type { TimelineCommand } from '../contracts';
export declare function compositeCommand(label: string, commands: TimelineCommand[]): TimelineCommand;
