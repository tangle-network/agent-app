/**
 * Seams between the intakes React surface and the host app. Everything here is
 * interface-only and callback-driven: the components never import an app's
 * router, fetch client, or toast system. The host passes the loaded view in and
 * supplies the async callbacks (which it backs with `./intakes/api` over fetch),
 * so the same interview mounts in any app and for either scope (user / project).
 */

import type { IntakeAnswerValue, IntakeQuestion } from '../intakes/model'

/** The state the interview renders — the shape `./intakes/api` returns. */
export interface IntakeView {
  title: string
  description?: string
  answers: Record<string, IntakeAnswerValue>
  /** The next question to ask, or null when the interview is done. */
  nextQuestion: IntakeQuestion | null
  completed: boolean
  progress: { answered: number; total: number }
}

/** Define properties and callbacks for managing the intake interview flow and user interactions */
export interface IntakeInterviewProps {
  view: IntakeView
  /**
   * Persist one answer; resolve with the next view (the server re-derives the
   * next question + progress). The component re-renders from the returned view.
   */
  onAnswer(input: { questionId: string; value: IntakeAnswerValue }): Promise<IntakeView>
  /** Finish the interview; resolve with the final view. */
  onComplete(): Promise<IntakeView>
  /** Called once when the interview is done (completed view), for navigation. */
  onDone?(): void
  /** Optional toast/notice hook; defaults to a no-op (host owns its UX). */
  onNotice?(notice: { kind: 'success' | 'error'; message: string }): void
}
