import type { IntakeGraph } from '../../src/intakes/model'

/** Linear per-user onboarding intake. */
export const onboardingGraph: IntakeGraph = {
  id: 'user-onboarding-v1',
  title: 'Welcome',
  description: 'A few questions to set you up.',
  questions: [
    { id: 'name', prompt: 'What should we call you?', type: 'text', required: true, min: 1 },
    { id: 'role', prompt: 'What is your role?', type: 'single-select', required: true, options: [
      { value: 'founder', label: 'Founder' },
      { value: 'marketer', label: 'Marketer' },
    ] },
    { id: 'newsletter', prompt: 'Want product updates?', type: 'boolean', required: false },
  ],
}

/** Branching per-project intake: "has website?" → no → skip the URL question. */
export const projectGraph: IntakeGraph = {
  id: 'project-intake-v1',
  title: 'Project setup',
  questions: [
    {
      id: 'has_site',
      prompt: 'Do you have a website?',
      type: 'boolean',
      required: true,
      next: (answers) => (answers.has_site === true ? 'site_url' : 'goals'),
    },
    { id: 'site_url', prompt: 'Website URL?', type: 'url', required: true, next: () => 'goals' },
    { id: 'goals', prompt: 'Top goals?', type: 'multi-select', required: true, min: 1, options: [
      { value: 'awareness', label: 'Awareness' },
      { value: 'leads', label: 'Leads' },
      { value: 'revenue', label: 'Revenue' },
    ] },
  ],
}
