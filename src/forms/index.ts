/**
 * `/forms` — fill a real agency PDF from semantic slots.
 *
 * THE ONE INVARIANT: the model supplies semantic slots (a form line, a named
 * box); the PLATFORM owns slot → widget. A widget name on an agency PDF
 * (`topmostSubform[0].Page2[0].f2_06[0]`, `registered2`) carries no meaning a
 * reader can check, so a model asked for one produces a plausible string — and
 * the natural audit, reading the field back by the name you wrote, passes
 * regardless because it re-reads the invention. Measured on tax-agent: three
 * figures written to model-chosen widgets landed in "Combat zone" and the date
 * boxes, audited 3 passed / 0 failed. Under this contract a misplaced value is
 * not merely unlikely — it is unrepresentable.
 *
 * Adding a form is a REGISTRY ENTRY, not a code path:
 *
 * ```ts
 * const blank: FormBlank = { base64, sha256, sourceUrl, byteLength }   // generated
 * const registry: FormRegistry = {
 *   form: 'us-tx-sos-205',
 *   revision: 'Rev. 12-21',
 *   slots: [
 *     { slot: 'entity_name', fields: ['The name of the entity is:'], kind: 'text',
 *       label: 'The name of the entity is:', labelBasis: 'widget' },
 *     { slot: 'agent_is_organization', fields: ['registered'], kind: 'checkbox',
 *       label: 'If the initial registered agent is an organization, …', labelBasis: 'widget' },
 *   ],
 * }
 *
 * const pdf = decodeFormBlank(blank)
 * const filled = await fillPdfForm({ pdf, registry, values: { entity_name: 'BLUE MESA KITCHEN LLC' } })
 * ```
 *
 * Two checks, and a product needs BOTH because they prove different things:
 *
 *  - `checkRegistryAgainstBlank` — PLACEMENT. Compares each slot's claimed
 *    label against the widget's own `/TU` text inside the PDF. This is the
 *    only check that can catch a slot aimed at the wrong box. Run it in CI.
 *  - `verifyFilledForm` — TRANSPORT. Reads the produced bytes back and
 *    confirms each value reached its widget. Fails on absence; an empty
 *    expectation set is `ok: false`, because `passed=0 failed=0` is the bug.
 *
 * A slot whose label CANNOT be re-checked against the file says so
 * (`labelBasis: 'derived'`) rather than presenting a guess as truth. Measured:
 * IRS f1040 carries `/TU` on 0 of 199 widgets, so its labels come from the XFA
 * template and are derived; every one of Texas Form 205's 64 widgets carries
 * `/TU`, so its whole registry is checkable.
 *
 * DERIVING a registry is form-family specific and stays in the product — an
 * IRS form's labels live in an XFA template, a Texas SOS form's live in `/TU`,
 * a third agency's may live only on paper. This subpath owns the CONTRACT the
 * derivation must satisfy, not the derivation.
 *
 * Server-only and opt-in: importing this subpath requires the otherwise
 * optional `pdf-lib` peer, which is why it is isolated behind its own entry.
 */

export {
  assertFormBlankIntegrity,
  decodeFormBlank,
  sha256Hex,
  type FormBlank,
} from './blank'

export {
  checkRegistryAgainstBlank,
  widgetLabel,
  type FormLabelBasis,
  type FormRegistry,
  type FormSlot,
  type FormSlotFormat,
  type FormSlotKind,
  type RegistryCheckResult,
  type RegistryProblem,
  type RegistryProblemCode,
} from './registry'

export {
  describeFormFill,
  fillPdfForm,
  formatFormCurrency,
  parseFormAmount,
  parseFormBoolean,
  type FilledWidget,
  type FillFormOptions,
  type FillFormResult,
  type UnfilledCode,
  type UnfilledSlot,
} from './fill'

export {
  verifyFilledForm,
  type LabelVerdict,
  type SlotVerdict,
  type SlotVerification,
  type VerifyFormResult,
} from './verify'
