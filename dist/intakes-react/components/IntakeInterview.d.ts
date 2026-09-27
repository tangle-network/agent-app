/**
 * Agent-led intake interview: asks one question at a time, advancing as each
 * answer is saved. Fully callback-driven — the host supplies the loaded `view`
 * and the async `onAnswer` / `onComplete` callbacks (backed by `./intakes/api`),
 * so this imports no app router, fetch client, or toast. Styled with the
 * shipped Tangle Quiet tokens (`var(--*)`).
 *
 * The server owns traversal: each `onAnswer` resolves with the next view (next
 * question + progress), so the component never re-derives the graph — it renders
 * `view.nextQuestion`, and when that is null and the view is completable it
 * shows the finish action. Local validation only gates the submit button; the
 * authoritative validation runs in the store.
 */
import type { IntakeInterviewProps } from '../contracts';
export declare function IntakeInterview({ view: initialView, onAnswer, onComplete, onDone, onNotice, }: IntakeInterviewProps): import("react").JSX.Element;
