/**
 * Tailwind preset mapping the shadcn semantic color names used by web-react
 * (bg-card, text-muted-foreground, border-border, …) onto the CSS variables in
 * tokens.css — so a consuming app themes every agent-app surface from one source.
 *
 *   // tailwind.config.{js,ts}
 *   import agentAppPreset from '@tangle-network/agent-app/tailwind-preset'
 *   export default { presets: [agentAppPreset], content: [...] }
 *
 * Pair with `import '@tangle-network/agent-app/styles'` for the variable values.
 * design-canvas/sequences need no preset — they consume vars via arbitrary
 * values (bg-[var(--bg-input)]), which Tailwind supports without color config.
 *
 * Beyond colour this preset also maps the border TIERS, the semantic radius
 * steps, the motion scale, and the elevation shadows. See docs/design-tokens.md.
 */
/** Define a preset configuration for dark mode and extended theme colors with foreground variants */
declare const agentAppPreset: {
    darkMode: [string, string];
    theme: {
        extend: {
            colors: {
                background: string;
                foreground: string;
                border: string;
                input: string;
                ring: string;
                success: {
                    DEFAULT: string;
                    foreground: string;
                };
                warning: {
                    DEFAULT: string;
                    foreground: string;
                    strong: string;
                };
                card: {
                    DEFAULT: string;
                    foreground: string;
                };
                popover: {
                    DEFAULT: string;
                    foreground: string;
                };
                primary: {
                    DEFAULT: string;
                    foreground: string;
                };
                secondary: {
                    DEFAULT: string;
                    foreground: string;
                };
                muted: {
                    DEFAULT: string;
                    foreground: string;
                };
                accent: {
                    DEFAULT: string;
                    foreground: string;
                };
                destructive: {
                    DEFAULT: string;
                    foreground: string;
                };
                'surface-container': string;
                'surface-container-high': string;
                'surface-container-highest': string;
            };
            boxShadow: {
                raised: string;
                overlay: string;
            };
            borderColor: {
                border: string;
                'card-edge': string;
                strong: string;
            };
            borderRadius: {
                control: string;
                card: string;
                surface: string;
            };
            transitionDuration: {
                instant: string;
                fast: string;
                base: string;
                slow: string;
            };
            transitionTimingFunction: {
                standard: string;
                entrance: string;
                exit: string;
            };
            keyframes: {
                slideDown: {
                    from: {
                        height: string;
                    };
                    to: {
                        height: string;
                    };
                };
                slideUp: {
                    from: {
                        height: string;
                    };
                    to: {
                        height: string;
                    };
                };
            };
            animation: {
                slideDown: string;
                slideUp: string;
            };
        };
    };
};
export default agentAppPreset;
