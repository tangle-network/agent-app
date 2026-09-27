/**
 * Design-canvas scene model — the product-agnostic document behind the visual
 * asset editor. A document is an ordered list of pages; a page is an ordered
 * list of elements (index order IS z-order, bottom→top); every element is a
 * typed node with a closed attribute vocabulary. The whole document
 * serializes as one JSON value and persists atomically with a revision
 * counter (see ./store) — every canvas action is a durable operation against
 * this schema, which is what makes the canvas automatable: agents and
 * external data sources mutate the same document the editor renders.
 *
 * Units are CSS pixels throughout; `settings.dpi` carries the print
 * conversion factor for bleed/trim-aware exports. Angles are degrees.
 * Nothing here touches Konva, React, or a database.
 */
/** Define the current version number of the scene schema */
export declare const SCENE_SCHEMA_VERSION = 1;
/** Define the structure and properties of a scene document including version, title, pages, settings, and metadata */
export interface SceneDocument {
    schemaVersion: typeof SCENE_SCHEMA_VERSION;
    title: string;
    pages: ScenePage[];
    settings: SceneSettings;
    metadata: Record<string, unknown>;
}
/** Define settings for scene export including print conversion factor for unit calculations */
export interface SceneSettings {
    /** Print conversion factor for mm↔px math at export; 96 = CSS default. */
    dpi: number;
}
/** Per-side bleed extents in px, drawn OUTSIDE the page bounds. Trim = the
 *  page rect itself; exports may include or exclude the bleed area. */
export interface PageBleed {
    top: number;
    right: number;
    bottom: number;
    left: number;
}
/** Saved ruler guides, in page coordinates. */
export interface PageGuides {
    vertical: number[];
    horizontal: number[];
}
/** Define the structure and properties of a scene page including layout, background, and elements */
export interface ScenePage {
    id: string;
    name: string;
    width: number;
    height: number;
    /** Page background fill (color string); elements paint over it. */
    background: string;
    bleed: PageBleed | null;
    guides: PageGuides;
    elements: SceneElement[];
}
/** Attributes every element carries. `x`/`y` are the element's top-left in
 *  page coordinates (for `group`, children are relative to the group origin).
 *  `slot` names a template binding point — `apply_data` targets it. */
export interface SceneElementBase {
    id: string;
    name: string;
    x: number;
    y: number;
    /** Degrees, clockwise, about the element's top-left origin (Konva default). */
    rotation: number;
    /** 0..1 */
    opacity: number;
    locked: boolean;
    visible: boolean;
    slot?: string;
}
/** Define a rectangular scene element with size, fill, optional stroke, and corner radius properties */
export interface RectElement extends SceneElementBase {
    kind: 'rect';
    width: number;
    height: number;
    fill: string;
    stroke?: string;
    strokeWidth?: number;
    cornerRadius?: number;
}
/** Define properties for an ellipse element including dimensions, fill, and optional stroke details */
export interface EllipseElement extends SceneElementBase {
    kind: 'ellipse';
    width: number;
    height: number;
    fill: string;
    stroke?: string;
    strokeWidth?: number;
}
/** Define a line element with points, stroke, stroke width, and optional dash pattern */
export interface LineElement extends SceneElementBase {
    kind: 'line';
    /** Flat [x0, y0, x1, y1, ...] relative to (x, y); ≥ 2 points. */
    points: number[];
    stroke: string;
    strokeWidth: number;
    dash?: number[];
}
/** Define properties for a text element including content, style, alignment, and layout parameters */
export interface TextElement extends SceneElementBase {
    kind: 'text';
    text: string;
    /** Wrap width; height derives from content. */
    width: number;
    fontFamily: string;
    fontSize: number;
    fontStyle: 'normal' | 'bold' | 'italic' | 'bold italic';
    fill: string;
    align: 'left' | 'center' | 'right';
    lineHeight: number;
    letterSpacing: number;
}
/** Define properties for an image element including source, dimensions, and fit mode */
export interface ImageElement extends SceneElementBase {
    kind: 'image';
    width: number;
    height: number;
    /** http(s) or rooted /api/ path — same boundary rule as sequences media. */
    src: string;
    /** How the source maps into the frame; 'fill' stretches, 'cover' crops. */
    fit: 'fill' | 'cover' | 'contain';
}
/** Video placed on a canvas renders and exports as its poster frame — motion
 *  belongs to the sequences surface; this keeps video assets placeable in
 *  static layouts (e.g. a thumbnail mock) without a playback engine. */
export interface VideoElement extends SceneElementBase {
    kind: 'video';
    width: number;
    height: number;
    src: string;
    posterSrc?: string;
}
/** Define a group element that contains multiple child scene elements */
export interface GroupElement extends SceneElementBase {
    kind: 'group';
    children: SceneElement[];
}
/** Represent a graphical element in a scene including shapes, text, media, or groups */
export type SceneElement = RectElement | EllipseElement | LineElement | TextElement | ImageElement | VideoElement | GroupElement;
/** Extract the kind property from a SceneElement to identify its element type */
export type SceneElementKind = SceneElement['kind'];
/** Define all valid kinds of scene elements used in the application */
export declare const SCENE_ELEMENT_KINDS: readonly SceneElementKind[];
/** Define rectangular boundaries with position and size properties */
export interface Bounds {
    x: number;
    y: number;
    width: number;
    height: number;
}
/** Unrotated local extent of an element (line/group derive from content). */
export declare function elementExtent(element: SceneElement): {
    width: number;
    height: number;
};
/** Estimate the height of multiline text based on font size and line height */
export declare function estimateTextHeight(element: Pick<TextElement, 'text' | 'fontSize' | 'lineHeight'>): number;
/** Axis-aligned bounding box in the parent's coordinate space, accounting for
 *  rotation about the element's top-left origin. */
export declare function elementAabb(element: SceneElement): Bounds;
/** Determine if two rectangular bounds overlap or intersect each other */
export declare function boundsIntersect(a: Bounds, b: Bounds): boolean;
/** Resolve and return a page by ID from a document or throw an error if not found */
export declare function requirePage(document: SceneDocument, pageId: string): ScenePage;
/** Depth-first search across a page including group children. Returns the
 *  element and the array that owns it (page.elements or a group's children),
 *  so callers can splice in place. */
export declare function findElement(page: ScenePage, elementId: string): {
    element: SceneElement;
    owner: SceneElement[];
    index: number;
} | null;
/** Resolve and return the element, its owner array, and index from the page by element ID */
export declare function requireElement(page: ScenePage, elementId: string): {
    element: SceneElement;
    owner: SceneElement[];
    index: number;
};
/** All slot names declared across the document — the template's fillable
 *  surface. Duplicate slot names are a validation error (see ./validate). */
export declare function collectSlots(document: SceneDocument): Map<string, {
    pageId: string;
    elementId: string;
    kind: SceneElementKind;
}>;
/** Define options to configure a new page including name, dimensions, and background color */
export interface NewPageOptions {
    name?: string;
    width?: number;
    height?: number;
    background?: string;
}
/** Create a new empty SceneDocument with a title and optional initial page settings */
export declare function createEmptyDocument(title: string, page?: NewPageOptions): SceneDocument;
/** Create a new ScenePage with specified options and a unique identifier */
export declare function createPage(options: NewPageOptions, id: string): ScenePage;
/** Assert that a value is a positive finite number and throw an error with a label if not */
export declare function assertPositiveFinite(value: number, label: string): void;
/** Assert that a value is a finite number and throw an error with a label if not */
export declare function assertFinite(value: number, label: string): void;
/** Validate that a string is a hex, rgb(a), or 'transparent' color and throw an error if not */
export declare function assertColor(value: string, label: string): void;
/** Media boundary rule shared with sequences: remote http(s) or a rooted
 *  /api/ path — never sandbox-local files or data:/blob: blobs. Delegates to the
 *  canonical `assertMediaUrl` boundary in `../web`; the two surfaces share ONE
 *  rule (trims, named-rejects local/inline schemes) so they cannot drift. */
export declare function assertSceneMediaSrc(value: string, label: string): void;
