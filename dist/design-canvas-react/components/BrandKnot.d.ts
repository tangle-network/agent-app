/**
 * Load the canonical Tangle knot only when a canvas surface renders it.
 * `/brand` imports the optional `@tangle-network/brand` peer, so a failed load
 * renders a fixed-size spacer instead of crashing the editor.
 */
interface BrandKnotProps {
    size?: number;
    className?: string;
}
export declare function BrandKnot({ size, className }: BrandKnotProps): import("react").JSX.Element;
export {};
