/**
 * `/journeys` — prove an agent app's product flows the way a person uses them:
 * recorded browser journeys as test identities, measured chat turns scored from
 * what the person saw, and videos a reviewer can watch. `agent-app-journeys`
 * runs the scripts and writes the INDEX.md a skeptical review starts from.
 *
 * Node only (browser automation, ffmpeg, the file system). Needs the optional
 * `playwright` peer, and `ffmpeg`/`ffprobe` on PATH for videos.
 * See docs/journeys.md.
 */
export {
  CONFIG_FILE_NAMES,
  credentialNames,
  DEFAULT_AUTH_PATHS,
  DEFAULT_CHAT_CONTRACT,
  defineJourneys,
  loadJourneysConfig,
  resolveJourneysConfig,
  threadRouteIn,
  type AuthPaths,
  type ChatContract,
  type JourneyIdentity,
  type JourneysConfig,
  type ResolvedJourneysConfig,
  type SignInMethod,
  type ThreadRoute,
} from './config.js'
export {
  DESKTOP,
  Journey,
  oneLine,
  PHONE,
  startJourney,
  type SendOptions,
  type StepRecord,
  type TurnRecord,
} from './journey.js'
export {
  DEFAULT_FAILURE_TEXT,
  DEFAULT_STOPPED_TEXT,
  scoreTurn,
  STATUS_STALE_MS,
  turnLooksActive,
  TurnEvidence,
  type FailurePatterns,
  type TranscriptSnapshot,
  type TurnFacts,
  type TurnOutcome,
  type TurnVerdict,
} from './score.js'
export { collectJourneyFiles, renderIndex, tallyTurns, type CriticResult, type IndexInput, type JourneyFiles } from './report.js'
export { assertNoSecrets, scrubTrace } from './scrub.js'
export { clickUntilSubmitted, createSubmissionTracker, routeSubmitPaths, settleText, type SendDriveOps, type SubmissionTracker } from './send.js'
export { secretNeedles, sessionUser, storageStateFor, type SessionUser } from './session.js'
export { chapterCues, extractFrames, highlightPlan, MAX_HIGHLIGHTS_S, postProcessVideo, rebuildVideo, type Chapter, type Cue, type HighlightSegment } from './video.js'
