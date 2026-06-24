/**
 * Design canvas editor component surface. `DesignCanvas` is the root component
 * products mount (see `../lazy` for the code-split entry). Leaf components are
 * exported for products that compose a custom editor shell from the same parts.
 *
 * Konva is an optional peer — all Konva-dependent components use it only
 * at render time so this index is safe to import in server bundles (tree-
 * shaking removes the Konva paths if they are never rendered).
 */
export { DesignCanvas, type DesignCanvasFullProps } from './DesignCanvas'
export { DesignCanvasEditor } from './DesignCanvasEditor'
export {
  CanvasInsertPanel,
  type CanvasInsertPanelProps,
  type InsertGeneration,
} from './CanvasInsertPanel'
export { Workspace, WorkspaceView, type WorkspaceViewProps } from './Workspace'
export { CanvasEmptyState, type CanvasEmptyStateProps } from './CanvasEmptyState'
export { SelectionLayer, type SelectionLayerProps } from './SelectionLayer'
export { PagesStrip, type PagesStripProps } from './PagesStrip'
export { LayersPanel, type LayersPanelProps } from './LayersPanel'
export { Toolbar, type ToolbarProps } from './Toolbar'
export { ZoomControls, type ZoomControlsProps } from './ZoomControls'
export {
  IconButton,
  type IconButtonProps,
  BTN,
  BTN_ACTIVE,
  BTN_SM,
  BTN_SM_ACTIVE,
} from './icon-button'
export { ExportControl, type ExportControlProps } from './ExportControl'
export { ElementNode, type ElementNodeProps } from './ElementNode'
export { GridLayer, type GridLayerProps } from './GridLayer'
export { Rulers, type RulersProps } from './Rulers'
export {
  flattenLayerTree,
  LAYERS_PANEL_ROW_LIMIT,
  type LayerRow,
} from './layer-tree'
export {
  bakeRectTransform,
  bakeLineTransform,
  bakeTextTransform,
  type TransformerNode,
  type BakedNodeAttrs,
} from './transform-math'
export {
  selectTickStep,
  buildRulerTicks,
  formatRulerLabel,
  type TickStep,
  type RulerTick,
} from './ruler-math'
