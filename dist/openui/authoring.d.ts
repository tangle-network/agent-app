/**
 * What the model is told about writing an interactive page.
 *
 * An agent will not emit a node vocabulary nobody described to it, so the
 * vocabulary and the prompt text that teaches it have to ship together. This
 * module is that text plus the machine-readable field/action shape it
 * describes, so five products do not each write their own (subtly different)
 * version into a system prompt.
 *
 * OPT-IN, DELIBERATELY. The input nodes render only where the host's renderer
 * knows them and the host passes an action handler. Advertise this guide only
 * once both are true for your product — otherwise the agent writes forms the
 * page will drop.
 */
import type { OpenUIFieldKind } from './values';
/** The input kinds this guide teaches, in the order it lists them. */
export declare const OPENUI_INPUT_KINDS: readonly OpenUIFieldKind[];
/**
 * The interactive vocabulary, written for a model.
 *
 * Appended to `render_ui`'s description by
 * `buildAppToolOpenAITools(taxonomy, { interactiveUi: true })`, and usable
 * directly in a system prompt for the inline ```` ```openui ```` path.
 */
export declare const OPENUI_INTERACTIVE_AUTHORING_GUIDE: string;
