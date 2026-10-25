/**
 * `/alerting` — the operational alert channel every product hand-rolled.
 *
 * The module's own doctrine, and the incident behind it, is in `./slack`.
 * Nothing domain-specific lives here: the message text and the decision to
 * alert are the caller's, this owns delivery and the honest verdict about it.
 */

export {
  postSlackAlert,
  type SlackAlertFailure,
  type SlackAlertOptions,
  type SlackAlertOutcome,
  type SlackFailureReason,
} from './slack'

export {
  createGithubIssueAlertChannel,
  type GithubIssueAlertChannel,
  type GithubIssueAlertOptions,
} from './github'
