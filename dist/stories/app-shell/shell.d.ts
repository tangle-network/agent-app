/**
 * App-shell composition pieces for the app-shell stories. The package ships NO
 * generic app-shell component on purpose — a product composes its own shell
 * from package primitives (`ChatMessages`, `ChatComposer`, `../../brand`) plus
 * its own sidebar. These are the story-local building blocks for that
 * composition: a session sidebar (recency sections, active item, status
 * affordances, new-chat button), a thread header, and the `AppShell` layout
 * that wires them together with a mobile drawer below `md`.
 *
 * Everything is Tailwind over the shared tokens (`bg-card`, `border-border`,
 * `text-muted-foreground`, `bg-primary`, …) so the global theme toolbar
 * restyles it, exactly like the `web-react` styling contract.
 */
import { type ReactNode } from 'react';
export type SessionStatus = 'idle' | 'running' | 'approval';
interface ShellSession {
    id: string;
    title: string;
    /** `running` shows a spinner, `approval` an amber dot — the two states a
     *  background agent session can be in while you're looking at another one. */
    status?: SessionStatus;
}
export interface ShellSessionSection {
    id: string;
    label: string;
    sessions: ShellSession[];
}
interface ShellUser {
    name: string;
    email: string;
}
export interface AppSidebarProps {
    sections: ShellSessionSection[];
    activeId?: string | null;
    /** Rail mode: icons only, 52px. */
    collapsed?: boolean;
    /** Row rhythm: `comfortable` is the default reading density, `compact` the
     *  power-user density for long histories. */
    density?: 'comfortable' | 'compact';
    pendingApprovals?: number;
    user?: ShellUser | null;
    onNewChat?: () => void;
    onSelectSession?: (id: string) => void;
    onToggleCollapse?: () => void;
    onOpenApprovals?: () => void;
    onOpenSettings?: () => void;
    onOpenAccount?: () => void;
    className?: string;
}
export declare function AppSidebar(props: AppSidebarProps): import("react").JSX.Element;
export interface AppShellProps {
    sections: ShellSessionSection[];
    activeSessionId?: string | null;
    sidebarCollapsed?: boolean;
    sidebarDensity?: 'comfortable' | 'compact';
    pendingApprovals?: number;
    user?: ShellUser | null;
    headerTitle: string;
    headerSubtitle?: string;
    onNewChat?: () => void;
    onSelectSession?: (id: string) => void;
    onToggleCollapse?: () => void;
    onOpenApprovals?: () => void;
    onOpenSettings?: () => void;
    onOpenAccount?: () => void;
    onShare?: () => void;
    onOpenThreadMenu?: () => void;
    /** The thread — typically `<ChatMessages/>`. Rendered in the scroll area. */
    children?: ReactNode;
    /** Typically `<ChatComposer/>`; pinned to the bottom of the main column and
     *  aligned to the same `max-w-3xl` reading column `ChatMessages` uses. */
    composer?: ReactNode;
}
/**
 * The production agent-app layout: sidebar (fixed on desktop, drawer below
 * `md`), header row, scrolling thread, pinned composer. Presentational only —
 * all behavior arrives via props, so stories drive it with fixtures and
 * console.log callbacks.
 */
export declare function AppShell({ sections, activeSessionId, sidebarCollapsed, sidebarDensity, pendingApprovals, user, headerTitle, headerSubtitle, onNewChat, onSelectSession, onToggleCollapse, onOpenApprovals, onOpenSettings, onOpenAccount, onShare, onOpenThreadMenu, children, composer, }: AppShellProps): import("react").JSX.Element;
export {};
