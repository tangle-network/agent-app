import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import { IntakeInterview } from '../../intakes-react'
import type { IntakeInterviewProps, IntakeView } from '../../intakes-react'
import type { IntakeAnswers } from '../../intakes/model'
import { INTAKE_STEPS, intakeViewFor } from './fixtures'

const meta: Meta<typeof IntakeInterview> = {
  title: 'Intakes/IntakeInterview',
  component: IntakeInterview,
}

export default meta
type Story = StoryObj<typeof IntakeInterview>

/** The interview mounts in a page column — constrain to a readable measure. */
function PageColumn({ children }: { children: React.ReactNode }) {
  return <div className="w-[520px] p-6">{children}</div>
}

const onNotice: IntakeInterviewProps['onNotice'] = (notice) => {
  console.log('onNotice', notice)
}

/** Static-step callbacks: log and hand the same view back (the host would
 *  return the server-derived next view; the interactive story does that). */
function loggingCallbacks(view: IntakeView) {
  return {
    onAnswer: (async (input) => {
      console.log('onAnswer', input)
      return view
    }) satisfies IntakeInterviewProps['onAnswer'],
    onComplete: (async () => {
      console.log('onComplete')
      return intakeViewFor(view.answers, true)
    }) satisfies IntakeInterviewProps['onComplete'],
    onDone: () => console.log('onDone'),
    onNotice,
  }
}

export const FirstQuestion: Story = {
  name: 'Step 1 — text',
  decorators: [(Story) => <PageColumn><Story /></PageColumn>],
  args: (() => {
    const view = intakeViewFor(INTAKE_STEPS.start)
    return { view, ...loggingCallbacks(view) }
  })(),
}

export const RoleSelect: Story = {
  name: 'Step 2 — single select',
  decorators: [(Story) => <PageColumn><Story /></PageColumn>],
  args: (() => {
    const view = intakeViewFor(INTAKE_STEPS.role)
    return { view, ...loggingCallbacks(view) }
  })(),
}

export const BriefingOptIn: Story = {
  name: 'Step 3 — boolean',
  decorators: [(Story) => <PageColumn><Story /></PageColumn>],
  args: (() => {
    const view = intakeViewFor(INTAKE_STEPS.briefings)
    return { view, ...loggingCallbacks(view) }
  })(),
}

export const ReadyToFinish: Story = {
  name: 'Ready to finish',
  decorators: [(Story) => <PageColumn><Story /></PageColumn>],
  args: (() => {
    const view = intakeViewFor(INTAKE_STEPS.ready)
    return { view, ...loggingCallbacks(view) }
  })(),
}

export const Completed: Story = {
  decorators: [(Story) => <PageColumn><Story /></PageColumn>],
  args: (() => {
    const view = intakeViewFor(INTAKE_STEPS.ready, true)
    return { view, ...loggingCallbacks(view) }
  })(),
}

/** Stable initial view — the component re-syncs when the prop reference
 *  changes, so the interactive story must not rebuild it per render. */
const INITIAL_VIEW = intakeViewFor(INTAKE_STEPS.start)

/** The full flow, driven through the async callbacks exactly as `intakes/api`
 *  would: each answer returns the re-derived next view. */
export const Interactive: Story = {
  name: 'Interactive — full flow',
  decorators: [(Story) => <PageColumn><Story /></PageColumn>],
  render: function InteractiveInterview() {
    const [answers, setAnswers] = useState<IntakeAnswers>(INTAKE_STEPS.start)
    return (
      <IntakeInterview
        view={INITIAL_VIEW}
        onDone={() => console.log('onDone')}
        onNotice={onNotice}
        onAnswer={async (input) => {
          console.log('onAnswer', input)
          const next = { ...answers, [input.questionId]: input.value }
          setAnswers(next)
          return intakeViewFor(next)
        }}
        onComplete={async () => {
          console.log('onComplete', answers)
          return intakeViewFor(answers, true)
        }}
      />
    )
  },
}

/** The whole interview arc on one canvas. */
export const AllStates: Story = {
  name: 'All states',
  // Two-column grid of 520px cells at xl — left-anchored so it can never clip.
  parameters: { layout: 'padded' },
  render: () => (
    <div className="grid gap-8 p-4 xl:grid-cols-2">
      {(
        [
          ['Step 1 — text (0/3)', intakeViewFor(INTAKE_STEPS.start)],
          ['Step 2 — single select (1/3)', intakeViewFor(INTAKE_STEPS.role)],
          ['Step 3 — boolean (2/3)', intakeViewFor(INTAKE_STEPS.briefings)],
          ['Ready to finish (3/3)', intakeViewFor(INTAKE_STEPS.ready)],
          ['Completed', intakeViewFor(INTAKE_STEPS.ready, true)],
        ] as const
      ).map(([label, view]) => (
        <div key={label} className="w-[520px]">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
          <div className="rounded-lg border border-border p-6">
            <IntakeInterview view={view} {...loggingCallbacks(view)} />
          </div>
        </div>
      ))}
    </div>
  ),
}
