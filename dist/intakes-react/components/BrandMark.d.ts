/**
 * Load the canonical Tangle knot only when an intakes surface renders it.
 * `/brand` imports the optional `@tangle-network/brand` peer, so a failed load
 * renders a fixed-size spacer instead of crashing the panel.
 */
export interface BrandMarkProps {
    size: number;
    className?: string;
}
export declare function BrandMark({ size, className }: BrandMarkProps): import("react").JSX.Element;
