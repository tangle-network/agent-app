export interface ApiAccessKey {
    id: string;
    name: string;
    scopes: string[];
    expiresAt: string | Date | null;
}
export interface ApiAccessScope {
    scope: string;
    label: string;
    description: string;
    requires?: readonly string[];
}
export interface ApiAccessPanelProps {
    keys: readonly ApiAccessKey[];
    access: readonly ApiAccessScope[];
    defaultScopes: readonly string[];
    baseUrl: string;
    expiryDays?: readonly number[];
    defaultExpiryDays?: number;
    accountHref?: string;
    description?: string;
    limitsDescription?: string;
    onCreate: (input: {
        name: string;
        scopes: string[];
        expiresAt: string;
    }) => Promise<{
        id: string;
        key: string;
    }>;
    onRevoke: (id: string) => Promise<void>;
    onChanged: () => void;
}
export declare function ApiAccessPanel({ keys, access, defaultScopes, baseUrl, accountHref, description, limitsDescription, expiryDays, defaultExpiryDays, onCreate, onRevoke, onChanged }: ApiAccessPanelProps): import("react").JSX.Element;
