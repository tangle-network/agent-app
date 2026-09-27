/**
 * The dependency graph, and running it as wide as the graph allows.
 *
 * CI runs these steps in a line because a YAML `steps:` list is a line. Nothing
 * about the work requires that: typecheck, the suite, the build and knip all
 * read source and none reads another's output. On a 32-core host, running them
 * concurrently is free wall-clock, and it is the only reason a strictly larger
 * verification can still finish faster than the CI it replaces.
 *
 * The graph is declared per step (`needs`), validated here, and the schedule is
 * derived from it — so an omitted edge is a correctness bug the repo owns, and
 * a cycle is named rather than deadlocking.
 */
export interface GraphNode {
    readonly name: string;
    readonly needs?: readonly string[];
}
/** Throws on a duplicate name, a dangling `needs`, or a cycle. */
export declare function validateGraph(nodes: readonly GraphNode[]): void;
type TaskStatus = 'passed' | 'failed' | 'skipped' | 'cancelled' | 'blocked';
export interface TaskOutcome<T> {
    readonly name: string;
    readonly status: TaskStatus;
    /** Present for anything that actually ran, including a cancelled task. */
    readonly value: T | null;
    readonly startedAtMs: number | null;
    readonly finishedAtMs: number | null;
}
export interface RunGraphOptions<TNode extends GraphNode, TValue> {
    readonly nodes: readonly TNode[];
    readonly maxParallel: number;
    /** `false` stops scheduling after the first failure and kills what is running. */
    readonly keepGoing: boolean;
    /** Runs one node. Resolves `{ ok }` for pass/fail; must not throw for a
     *  failing command — a non-zero exit is data. */
    readonly run: (node: TNode, signal: AbortSignal) => Promise<{
        readonly ok: boolean;
        readonly value: TValue;
    }>;
    /** Wall-clock origin, so outcomes are comparable across the whole run. */
    readonly now?: () => number;
}
/**
 * Run the graph, honouring dependencies and the parallelism cap.
 *
 * Failure semantics, stated because they are the difference between a gate you
 * trust and one you argue with:
 *  - fail-fast (default): nothing new is scheduled, everything in flight is
 *    aborted and reported as `cancelled`, everything unstarted as `skipped`.
 *  - `keepGoing`: independent work continues, but a step whose dependency
 *    failed is reported `blocked`. It is never reported as passed, and never
 *    silently omitted.
 */
export declare function runGraph<TNode extends GraphNode, TValue>(options: RunGraphOptions<TNode, TValue>): Promise<TaskOutcome<TValue>[]>;
export {};
