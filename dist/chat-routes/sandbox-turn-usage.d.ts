import { type JsonRecord } from '../stream/index';
import type { ChatTurnUsage } from './turn-routes';
/** Add one canonical Sandbox `step-finish` receipt to a turn total. */
export declare function addStepFinishUsage(part: JsonRecord, usage: ChatTurnUsage): void;
