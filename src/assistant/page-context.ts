/**
 * The page the assistant is looking at, read from the document title. Product
 * pages already name themselves in `<title>` for tabs and history, so the
 * title is the label; watching it keeps hosts free of per-page wiring and
 * follows titles that settle late (a run page names its workflow once the
 * workflow loads). A page whose title does not name what it shows sets its own
 * label with `useAssistantPageLabel`, which wins over the title.
 */

import { useEffect, useMemo, useState } from "react";
import { useOptionalAssistantLauncher } from "./launcher";
import type { AssistantPageContext } from "./types";

const MAX_LABEL = 200;

/** Pass module-level `titleSuffix`, `ignoreTitles` and `ids` so the context
 *  keeps its identity between renders. */
export interface DocumentPageContextOptions {
  /** The current in-app path, from the host router. */
  path: string;
  /** The product suffix to drop from titles, e.g. / — Tangle Platform$/. */
  titleSuffix?: RegExp;
  /** Titles that name no particular page (the bare product name). */
  ignoreTitles?: readonly string[];
  /** Tool-facing ids for the path, e.g. `{ workflowId, runId }`. */
  ids?: (path: string) => Record<string, string> | undefined;
}

/** `title` minus the product suffix, or null when nothing page-specific is left. */
export function pageLabelFromTitle(
  title: string,
  titleSuffix?: RegExp,
  ignoreTitles: readonly string[] = [],
): string | null {
  const label = (titleSuffix ? title.replace(titleSuffix, "") : title).trim();
  if (!label || ignoreTitles.includes(label)) return null;
  return label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label;
}

function useDocumentTitle(): string {
  const [title, setTitle] = useState(() =>
    typeof document === "undefined" ? "" : document.title,
  );
  useEffect(() => {
    const update = () => setTitle(document.title);
    const observer = new MutationObserver(update);
    observer.observe(document.head, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    update();
    return () => observer.disconnect();
  }, []);
  return title;
}

export function useDocumentPageContext({
  path,
  titleSuffix,
  ignoreTitles,
  ids,
}: DocumentPageContextOptions): AssistantPageContext | null {
  const title = useDocumentTitle();
  const pageLabel = useOptionalAssistantLauncher()?.pageLabel ?? null;
  return useMemo(() => {
    const label =
      (pageLabel && pageLabelFromTitle(pageLabel)) ??
      pageLabelFromTitle(title, titleSuffix, ignoreTitles);
    if (!label) return null;
    const pageIds = ids?.(path);
    return { label, path, ...(pageIds ? { ids: pageIds } : {}) };
  }, [pageLabel, title, path, titleSuffix, ignoreTitles, ids]);
}
