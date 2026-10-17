/**
 * `settings-react` — the settings page every agent product composes: the
 * section layout and links, one save behaviour for every field, the
 * confirmation for costly or destructive actions, a grouped save bar, and the
 * shared sections (members, invitations, export, delete) plus the timezone
 * field. Rows, sections and fields are `@tangle-network/ui/primitives`
 * (`SettingsRow`, `SettingsSection`, `SettingsList`, `Field`); this entry
 * composes them. The contract is in `docs/product-surfaces.md#settings-pages`.
 *
 * Never re-exported from the package root: `react` is an optional peer.
 */

export {
  SettingsLayout,
  SettingsNav,
  type SettingsIcon,
  type SettingsLayoutProps,
  type SettingsLinkComponent,
  type SettingsLinkProps,
  type SettingsNavProps,
  type SettingsNavSection,
} from './settings-layout'

export {
  useSettingField,
  type SettingField,
  type SettingFieldRowProps,
  type SettingFieldState,
  type UseSettingFieldOptions,
} from './use-setting-field'

export {
  confirmSettingResponse,
  settingFailure,
  type SettingFailure,
  type SettingFailureCode,
} from './setting-outcome'

export { ConfirmAction, type ConfirmActionProps, type ConfirmChange } from './confirm-action'
export { SettingsSaveBar, type SettingsSaveBarProps } from './settings-save-bar'
export {
  InvitationsSection,
  MembersSection,
  type InvitationsSectionProps,
  type MembersSectionProps,
} from './members-section'
export { ExportSection, type ExportSectionProps } from './export-section'
export {
  DeleteWorkspaceSection,
  type DeleteCount,
  type DeleteWorkspaceSectionProps,
} from './delete-workspace-section'
export { TimezonePicker, type TimezonePickerProps } from './timezone-picker'
