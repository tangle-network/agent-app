// src/web-react/async/state.ts
var DEFAULT_ASYNC_ERROR_MESSAGE = "Something went wrong. Please try again.";
function defaultIsEmpty(value) {
  if (value === null || value === void 0) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (value instanceof Map || value instanceof Set) return value.size === 0;
  return false;
}
function hasMessage(value) {
  return "message" in value;
}
function asyncErrorMessage(error, fallback = DEFAULT_ASYNC_ERROR_MESSAGE) {
  if (typeof error === "string" && error.trim() !== "") return error;
  if (typeof error === "object" && error !== null && hasMessage(error)) {
    const message = error.message;
    if (typeof message === "string" && message.trim() !== "") return message;
  }
  return fallback;
}
function resolveAsyncValue(value, isEmpty = defaultIsEmpty) {
  return isEmpty(value) ? { status: "empty", value } : { status: "ready", value };
}
var AsyncRequestError = class extends Error {
  status;
  statusText;
  url;
  /** First 200 characters of the response body when it could be read, else `''`.
   *  Kept off `message` so a server's HTML error page never becomes UI copy. */
  body;
  constructor(response, body = "") {
    const statusText = response.statusText ?? "";
    super(`Request failed (${response.status}${statusText ? ` ${statusText}` : ""})`);
    this.name = "AsyncRequestError";
    this.status = response.status;
    this.statusText = statusText;
    this.url = response.url ?? "";
    this.body = body;
  }
};
async function readBodySnippet(response) {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return "";
  }
}
async function requireOk(response) {
  if (response.ok) return response;
  throw new AsyncRequestError(response, await readBodySnippet(response));
}
async function readOkJson(response, parse) {
  await requireOk(response);
  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw new Error("The response was not valid JSON.", { cause: error });
  }
  return parse ? parse(data) : data;
}

// src/web-react/async/use-async-resource.ts
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
function useChangeToken(deps) {
  const ref = useRef({ deps, token: 0 });
  const changed = ref.current.deps.length !== deps.length || deps.some((dep, index) => !Object.is(dep, ref.current.deps[index]));
  if (changed) ref.current = { deps, token: ref.current.token + 1 };
  return ref.current.token;
}
var NO_DEPS = [];
function useAsyncResource({
  load,
  deps = NO_DEPS,
  enabled = true,
  initialValue,
  isEmpty,
  errorMessage
}) {
  const loadRef = useRef(load);
  loadRef.current = load;
  const isEmptyRef = useRef(isEmpty ?? defaultIsEmpty);
  isEmptyRef.current = isEmpty ?? defaultIsEmpty;
  const errorMessageRef = useRef(errorMessage);
  errorMessageRef.current = errorMessage;
  const [resolution, setResolution] = useState(() => {
    if (initialValue !== void 0) return resolveAsyncValue(initialValue, isEmpty ?? defaultIsEmpty);
    return enabled ? { status: "loading" } : { status: "idle" };
  });
  const [reloadKey, setReloadKey] = useState(0);
  const seqRef = useRef(0);
  const seededRef = useRef(initialValue !== void 0);
  const token = useChangeToken(deps);
  useEffect(() => {
    if (!enabled) return;
    if (seededRef.current) {
      seededRef.current = false;
      return;
    }
    const seq = ++seqRef.current;
    const controller = new AbortController();
    setResolution({ status: "loading" });
    void (async () => {
      try {
        const value = await loadRef.current({ signal: controller.signal });
        if (seq !== seqRef.current || controller.signal.aborted) return;
        setResolution(resolveAsyncValue(value, isEmptyRef.current));
      } catch (error) {
        if (seq !== seqRef.current || controller.signal.aborted) return;
        setResolution({
          status: "error",
          message: errorMessageRef.current ? errorMessageRef.current(error) : asyncErrorMessage(error),
          error
        });
      }
    })();
    return () => controller.abort();
  }, [token, enabled, reloadKey]);
  const retry = useCallback(() => {
    setReloadKey((key) => key + 1);
  }, []);
  return useMemo(() => {
    switch (resolution.status) {
      case "ready":
        return { status: "ready", value: resolution.value, retry };
      case "empty":
        return { status: "empty", value: resolution.value, retry };
      case "error":
        return { status: "error", message: resolution.message, error: resolution.error, retry };
      case "loading":
        return { status: "loading", retry };
      case "idle":
        return { status: "idle", retry };
    }
  }, [resolution, retry]);
}

// src/web-react/async/use-confirmed-mutation.ts
import { useCallback as useCallback2, useMemo as useMemo2, useRef as useRef2, useState as useState2 } from "react";
var CONFIRMED_WRITE = /* @__PURE__ */ Symbol("agent-app.confirmed-write");
function confirmWrite(value) {
  return { succeeded: true, value, [CONFIRMED_WRITE]: true };
}
function rejectWrite(message, error) {
  return error === void 0 ? { succeeded: false, message } : { succeeded: false, message, error };
}
async function confirmResponse(response) {
  try {
    return confirmWrite(await requireOk(response));
  } catch (error) {
    return rejectWrite(asyncErrorMessage(error), error);
  }
}
async function confirmJson(response, parse) {
  try {
    return confirmWrite(await readOkJson(response, parse));
  } catch (error) {
    return rejectWrite(asyncErrorMessage(error), error);
  }
}
function isConfirmedWrite(outcome) {
  if (typeof outcome !== "object" || outcome === null) return false;
  return outcome[CONFIRMED_WRITE] === true;
}
function asRejection(outcome) {
  if (typeof outcome !== "object" || outcome === null) return null;
  const candidate = outcome;
  if (candidate.succeeded !== false) return null;
  const message = typeof candidate.message === "string" && candidate.message.trim() !== "" ? candidate.message : UNCONFIRMED_MESSAGE;
  return rejectWrite(message, candidate.error);
}
var UNCONFIRMED_MESSAGE = "The write could not be confirmed.";
var UNCONFIRMED_CONTRACT = "mutate() resolved without a confirmation. Return confirmWrite(value), confirmResponse(response) or confirmJson(response, parse) so the success state proves the write landed.";
function useConfirmedMutation({
  mutate,
  onSucceeded,
  onFailed,
  errorMessage
}) {
  const mutateRef = useRef2(mutate);
  mutateRef.current = mutate;
  const onSucceededRef = useRef2(onSucceeded);
  onSucceededRef.current = onSucceeded;
  const onFailedRef = useRef2(onFailed);
  onFailedRef.current = onFailed;
  const errorMessageRef = useRef2(errorMessage);
  errorMessageRef.current = errorMessage;
  const [state, setState] = useState2({ status: "idle" });
  const seqRef = useRef2(0);
  const inFlightRef = useRef2(null);
  const run = useCallback2(async (input) => {
    inFlightRef.current?.abort();
    const controller = new AbortController();
    inFlightRef.current = controller;
    const seq = ++seqRef.current;
    setState({ status: "pending" });
    let outcome;
    try {
      const returned = await mutateRef.current(input, { signal: controller.signal });
      outcome = isConfirmedWrite(returned) ? returned : asRejection(returned) ?? rejectWrite(UNCONFIRMED_MESSAGE, new Error(UNCONFIRMED_CONTRACT));
    } catch (error) {
      outcome = rejectWrite(errorMessageRef.current ? errorMessageRef.current(error) : asyncErrorMessage(error), error);
    }
    if (seq !== seqRef.current) return outcome;
    if (outcome.succeeded) {
      setState({ status: "succeeded", value: outcome.value });
      onSucceededRef.current?.(outcome.value);
    } else {
      setState({ status: "failed", message: outcome.message, error: outcome.error });
      onFailedRef.current?.(outcome.message, outcome.error);
    }
    return outcome;
  }, []);
  const reset = useCallback2(() => {
    seqRef.current += 1;
    inFlightRef.current?.abort();
    inFlightRef.current = null;
    setState({ status: "idle" });
  }, []);
  return useMemo2(() => ({ state, run, reset }), [state, run, reset]);
}

// src/web-react/async/async-view.tsx
import { isValidElement } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
var BLOCK_CLASS = "flex flex-col items-center justify-center gap-2 px-4 py-10 text-center";
function AsyncView({
  state,
  children,
  empty,
  renderLoading,
  renderError,
  renderIdle,
  loadingLabel = "Loading\u2026",
  retryLabel = "Retry",
  className
}) {
  if (state.status === "ready") return /* @__PURE__ */ jsx(Fragment, { children: children(state.value) });
  const branch = () => {
    switch (state.status) {
      case "idle":
        return renderIdle?.() ?? /* @__PURE__ */ jsx(LoadingBlock, { label: loadingLabel });
      case "loading":
        return renderLoading?.() ?? /* @__PURE__ */ jsx(LoadingBlock, { label: loadingLabel });
      case "error":
        return renderError?.({ message: state.message, retry: state.retry }) ?? /* @__PURE__ */ jsx(ErrorBlock, { message: state.message, retry: state.retry, retryLabel });
      case "empty":
        if (isValidElement(empty)) return empty;
        return typeof empty === "object" && empty !== null && typeof empty.title === "string" ? /* @__PURE__ */ jsx(EmptyBlock, { spec: empty }) : /* @__PURE__ */ jsx(EmptyBlock, { spec: { title: "Nothing here yet." } });
    }
  };
  const busy = state.status === "loading" || state.status === "idle";
  const failed = state.status === "error";
  return /* @__PURE__ */ jsx(
    "div",
    {
      "data-async-state": state.status,
      className,
      role: failed ? void 0 : "status",
      "aria-live": failed ? void 0 : "polite",
      "aria-busy": busy,
      children: branch()
    }
  );
}
function LoadingBlock({ label }) {
  return /* @__PURE__ */ jsxs("div", { className: BLOCK_CLASS, children: [
    /* @__PURE__ */ jsx(
      "span",
      {
        className: "h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent",
        "aria-hidden": "true"
      }
    ),
    /* @__PURE__ */ jsx("span", { className: "text-sm text-muted-foreground", children: label })
  ] });
}
function ErrorBlock({
  message,
  retry,
  retryLabel
}) {
  return /* @__PURE__ */ jsxs("div", { role: "alert", className: BLOCK_CLASS, children: [
    /* @__PURE__ */ jsx("p", { className: "max-w-md text-sm text-muted-foreground", children: message }),
    /* @__PURE__ */ jsx(
      "button",
      {
        type: "button",
        onClick: retry,
        className: "h-8 rounded-md border border-border px-3 text-xs font-medium text-foreground transition hover:bg-accent",
        children: retryLabel
      }
    )
  ] });
}
function EmptyBlock({ spec }) {
  return /* @__PURE__ */ jsxs("div", { className: BLOCK_CLASS, children: [
    /* @__PURE__ */ jsx("p", { className: "text-sm font-medium text-foreground", children: spec.title }),
    spec.description ? /* @__PURE__ */ jsx("p", { className: "max-w-md text-sm text-muted-foreground", children: spec.description }) : null,
    spec.action ? isValidElement(spec.action) ? spec.action : /* @__PURE__ */ jsx(
      "button",
      {
        type: "button",
        onClick: spec.action.onClick,
        className: "h-8 rounded-md border border-border px-3 text-xs font-medium text-foreground transition hover:bg-accent",
        children: spec.action.label
      }
    ) : null
  ] });
}
function MutationStatus({ state, labels, className }) {
  if (state.status === "idle") return null;
  if (state.status === "pending") {
    return /* @__PURE__ */ jsx("span", { role: "status", "aria-live": "polite", "aria-busy": true, className: className ?? "text-xs text-muted-foreground", children: labels?.pending ?? "Saving\u2026" });
  }
  if (state.status === "succeeded") {
    return /* @__PURE__ */ jsx("span", { role: "status", "aria-live": "polite", "aria-busy": false, className: className ?? "text-xs text-muted-foreground", children: labels?.succeeded ?? "Saved" });
  }
  return /* @__PURE__ */ jsx("span", { role: "alert", className: className ?? "text-xs text-destructive", children: state.message });
}

export {
  DEFAULT_ASYNC_ERROR_MESSAGE,
  defaultIsEmpty,
  asyncErrorMessage,
  resolveAsyncValue,
  AsyncRequestError,
  requireOk,
  readOkJson,
  useAsyncResource,
  CONFIRMED_WRITE,
  confirmWrite,
  rejectWrite,
  confirmResponse,
  confirmJson,
  isConfirmedWrite,
  useConfirmedMutation,
  AsyncView,
  MutationStatus
};
//# sourceMappingURL=chunk-3UBAO3N5.js.map