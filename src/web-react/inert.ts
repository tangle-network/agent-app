/**
 * `inert`, across the React versions this package's peer range admits.
 *
 * MEASURED, not reasoned. `react` + `react-dom` 18.3.1 and 19.2.8, each
 * rendering `<div inert={…}>x</div>` through `renderToStaticMarkup`, and the
 * same four cases re-read as `outerHTML` after `createRoot().render` — server
 * and client agreed on every row:
 *
 * | prop            | React 18.3.1                    | React 19.2.8                    |
 * | --------------- | ------------------------------- | ------------------------------- |
 * | `inert={false}` | `<div>x</div>` — NO attribute   | `<div>x</div>` — NO attribute   |
 * | `inert={''}`    | `<div inert="">x</div>` — inert | `<div>x</div>` — NO attribute   |
 * | `inert={true}`  | `<div>x</div>` — NO attribute   | `<div inert="">x</div>` — inert |
 * | `inert={'1'}`   | `<div inert="1">x</div>` — inert | `<div inert="">x</div>` — inert |
 *
 * React 18 warns on the two it drops (`Received \`false\`/\`true\` for a
 * non-boolean attribute \`inert\`.`); React 19 warns on the one it drops
 * (`Received an empty string for a boolean attribute \`inert\`.`).
 *
 * So the FALSE case needs no help: both majors already emit nothing, and a
 * plain `inert={!open}` binding never made an open panel inert on either. The
 * TRUE case is the defect — `true` is dropped by 18 and `''` is dropped by 19,
 * so a plain boolean binding leaves a COLLAPSED panel focusable and
 * screen-reader readable on React 18, which `peerDependencies` (`react >=18`)
 * admits.
 *
 * The last row is the answer, and it is why this file no longer detects
 * anything. `inert` is an HTML boolean attribute: its PRESENCE is what makes an
 * element inert, whatever the value reads. A non-empty string is emitted by
 * both majors, warned about by neither, and inert on both — so there is one
 * spelling and no branch.
 */

/**
 * Props that make an element inert when `inert` is true, and nothing at all
 * when it is false.
 */
export function inertProps(inert: boolean): { inert?: boolean } {
  if (!inert) return {}
  // The cast is because @types/react 19 declares `inert` a boolean.
  return { inert: '1' } as unknown as { inert?: boolean }
}
