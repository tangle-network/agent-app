export { traceSandboxPromptEvents, type TraceSandboxPromptOptions } from './prompt-trace'

export {
  createCacheReuseStore,
  type ReuseCacheLike,
  type ReuseChecks,
  type ReuseStateStore,
  type SharedReuseState,
} from './reuse-state'

// A value warmed once and read by every isolate in the data center (isolate + colo layers).
export * from './warm-cache'

export type { Outcome } from './outcome'

export * from './binary-read'

export * from './transient-failure'

export {
  resolveModel,
  resolveModelSelection,
  backendModelFields,
  requireTransportableModel,
  SandboxModelResolutionError,
} from './model'

export type {
  ProviderResolutionConfig,
  ResolvedModel,
  ModelSelection,
  ModelSelectionFailure,
  ModelSelectionError,
  ModelSelectionSource,
} from './model'

export type { StorageConfig } from '@tangle-network/sandbox'

export * from './recovery'

export {
  serializeSandboxProvisioningError,
  formatSandboxProvisioningSupportDetails,
  formatSandboxProvisioningUserMessage,
  isSandboxAuthFailure,
  isSandboxApiBearerAuthFailure,
  isSandboxApiSandboxMissingFailure,
  isSandboxApiTransientFailure,
  SANDBOX_BACKING_CONTAINER_MISSING_CODE,
  isSandboxHostCapacityFailure,
  type SafeSandboxErrorCause,
  type SafeSandboxErrorDiagnostics,
} from './diagnostics'

// Generic name-keyed workspace sandbox lifecycle manager.
export * from './workspace-sandbox-manager'

// Browser-direct scoped-token terminal connection route (#341/#349/#350).
export * from './terminal-connection'

// Background box warming on project open: single-flight, non-blocking, and
// explicit about spend. Imports `ensureWorkspaceSandbox`/`peekWorkspaceSandbox`
// back out of this module; tsup inlines both files into the one
// `sandbox/index` chunk, so the cycle exists only in source.
export * from './prewarm'

export * from './sandbox-run-tool'

export * from './sandbox-exec-tool'

export * from './prewarm-claim-d1'

export * from './prewarm-route'
export * from './warm-receipts'

export * from './foreground-single-flight'

// Signal-driven warm leases: resume ahead of need, budget the misses, learn the daily ramp.
export * from './warm-lease'

export * from './warm-lease-d1'

// Speculative warm for turns likely to call a sandbox tool (agent turn architecture S8).
export * from './escalation-speculator'

export { resolveSandboxClientCredentials } from './credentials'

export type {
  SandboxClientCredentials,
  SandboxCredentialEnvironment,
  ResolveSandboxClientCredentialsOptions,
} from './credentials'

export { DEFAULT_SANDBOX_RESOURCES } from './configuration'

export type {
  SandboxResourceConfig,
  SandboxBuildContext,
  SandboxScope,
  SandboxRestoreSpec,
  StoppedSandboxResumeFailure,
  MissingSandboxFailure,
  StoppedSandboxResumeRecovery,
  LivenessProbeConfig,
  ProfileComposeOptions,
  SandboxRuntimeConfig,
  EnsureWorkspaceSandboxOptions,
  SandboxProvisionedObservation,
  SandboxSpendHooks,
} from './configuration'

export { PYPI_EGRESS_DOMAINS, buildProductEgressPolicy } from './product-egress'

export { dropTrustedBox, getClient, resetClientCache } from './runtime-cache'

export {
  buildAppToolMcpServers,
  sandboxToolRootDir,
  sandboxToolBinDir,
  sandboxToolPath,
  buildSandboxToolFileMounts,
  buildSandboxToolBinDirsEnv,
  buildSandboxToolBinDirScript,
  buildSandboxToolPathSetupScript,
  ensureSandboxToolBinDir,
  runSandboxToolPathSetup,
} from './app-tools'

export type {
  AppToolDescriptor,
  BuildAppToolMcpServersOptions,
  SandboxToolSpec,
  SandboxToolPathOptions,
  BuildSandboxToolFileMountsOptions,
} from './app-tools'

export { splitDeferredProfileFiles, writeProfileFilesToBox } from './profile-files'

export type { WriteProfileFilesOptions } from './profile-files'

export {
  SandboxEgressPolicyMismatchError,
  SandboxRuntimeAuthRefreshError,
  SandboxRecoveryFailedError,
  SandboxBoxBusyError,
} from './lifecycle-errors'

export type { SandboxExistingBoxStage, SandboxEgressPolicySource, SandboxRecoveryPhase } from './lifecycle-errors'

export { deferredCorpusHash } from './profile-corpus'

export {
  PROVISION_PAYLOAD_MAX_BYTES,
  ENV_VALUE_MAX_BYTES,
  DEFAULT_PROVISION_TIMEOUT_MS,
  ENV_TOTAL_MAX_BYTES,
  assertProvisionPayloadWithinCap,
  assertEnvWithinLimits,
} from './payload-limits'

export type { ProvisionProfileSection, ProvisionPayloadSections } from './payload-limits'

export { peekWorkspaceSandbox } from './workspace-boxes'

export type { PeekWorkspaceSandboxOutcome } from './workspace-boxes'

export { ensureWorkspaceSandbox, reuseWorkspaceSandbox } from './workspace-claim'

export {
  flattenHistory,
  mergeHistoryIntoParts,
  mergeExtraMcp,
  attachReasoningEffort,
  applyPromptTokenLimits,
  resolveSandboxPromptBackend,
} from './prompt-profile'

export type { PromptInputPart, SandboxPromptTokenLimits, SandboxPromptConfig } from './prompt-profile'

export type { StreamSandboxPromptOptions } from './prompt-options'

export {
  adaptSandboxStream,
  classifySeveredStream,
  isTerminalPromptEvent,
  detectInteractiveQuestion,
} from './prompt-events'

export type { SandboxStreamEvent, SandboxStepTransition } from './prompt-events'

export { SANDBOX_DISPATCH_TRANSIENT_DEADLINE_MS, streamSandboxPrompt } from './prompt-dispatch'

export { collectSandboxPromptText, runSandboxPrompt, driveSandboxTurn } from './prompt-result'

export type { DriveSandboxTurnOptions } from './prompt-result'

export {
  syncSandboxMemberAdd,
  syncSandboxMemberRemove,
  syncSandboxMemberRole,
  secretStoreFromClient,
  storeSecret,
  deleteSecret,
  mintSandboxScopedToken,
} from './access'

export type { SandboxPermissionLevel, MemberSyncSeam, SecretStore, ScopedTokenResult } from './access'
