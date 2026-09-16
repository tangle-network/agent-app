# Changelog

## Unreleased

### Changed

- Update evaluator, execution, knowledge, and profile dependencies as one supported set.
  Generated applications use the same dependency versions.
- Forward evaluator revisions and paid-call context through ensemble judges.
  Campaign caches invalidate when `judgeVersion` changes, and paid calls retain campaign cost tags.
- Clarify that rater agreement does not establish evaluator accuracy or authorize promotion.

### Added

- Export renderer-neutral `groupConversationMessages` from the existing `/web`
  foundation. Repeated assistant updates share attribution until a real user,
  speaker, or conversation boundary; original messages remain intact.
- Add attribution tests and usage/accessibility guidance for framework-neutral
  and React consumers. No new rendering framework or execution state is added.

### Internal

- Move the existing web utilities unchanged into `web/core.ts` behind the same
  public barrel. All previous exports and optional-peer boundaries are preserved.

No release version is assigned here; publishing remains owned by the existing
repository release workflow.
