// src/openui-react/index.tsx
import { useCallback, useRef, useState } from "react";
var RESERVED_BODY_KEYS = ["actionId", "formId", "values", "nodeId", "artifactPath"];
function asNodes(schema) {
  if (!schema) return null;
  const nodes = Array.isArray(schema) ? schema : [schema];
  return nodes.length > 0 ? nodes : null;
}
function failureFrom(payload, status, actionId) {
  const record = payload && typeof payload === "object" ? payload : {};
  const code = typeof record.code === "string" && record.code ? record.code : `OPENUI_ACTION_HTTP_${status}`;
  const error = typeof record.error === "string" && record.error ? record.error : typeof record.message === "string" && record.message ? record.message : "That action could not be completed.";
  const issues = Array.isArray(record.issues) ? record.issues : void 0;
  return { code, error, actionId, ...issues ? { issues } : {} };
}
function useOpenUIActions(options) {
  const initial = options.initialValues ?? {};
  const [values, setValuesState] = useState(initial);
  const [pendingActionId, setPendingActionId] = useState(null);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [schema, setSchema] = useState(null);
  const [data, setData] = useState(null);
  const valuesRef = useRef(initial);
  const pendingRef = useRef(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const setValues = useCallback((next) => {
    valuesRef.current = next;
    setValuesState(next);
  }, []);
  const setValue = useCallback((fieldId, value) => {
    const next = { ...valuesRef.current, [fieldId]: value };
    valuesRef.current = next;
    setValuesState(next);
  }, []);
  const resetValues = useCallback(() => {
    const next = optionsRef.current.initialValues ?? {};
    valuesRef.current = next;
    setValuesState(next);
  }, []);
  const submit = useCallback(
    async (action, context) => {
      const current = optionsRef.current;
      if (pendingRef.current) {
        const busy = {
          code: "OPENUI_ACTION_BUSY",
          error: "Another action is still running. Wait for it to finish.",
          actionId: action.id
        };
        setError(busy);
        current.onResult?.({ succeeded: false, error: busy });
        return { succeeded: false, error: busy };
      }
      const submitted = context?.values ?? valuesRef.current;
      if (context?.values) setValues(context.values);
      pendingRef.current = action.id;
      setPendingActionId(action.id);
      setError(null);
      setMessage(null);
      const body = {
        ...current.body,
        actionId: action.id,
        values: submitted,
        ...context?.formId ? { formId: context.formId } : {},
        ...context?.nodeId ? { nodeId: context.nodeId } : {},
        ...current.artifactPath ? { artifactPath: current.artifactPath } : {}
      };
      const doFetch = current.fetchImpl ?? fetch;
      let outcome;
      try {
        const response = await doFetch(current.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", ...current.headers },
          body: JSON.stringify(body)
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          outcome = { succeeded: false, error: failureFrom(payload, response.status, action.id) };
        } else {
          const record = payload && typeof payload === "object" ? payload : {};
          if (record.ok !== true) {
            outcome = { succeeded: false, error: failureFrom(payload, response.status, action.id) };
          } else {
            outcome = {
              succeeded: true,
              value: {
                ok: true,
                actionId: typeof record.actionId === "string" ? record.actionId : action.id,
                ...typeof record.message === "string" ? { message: record.message } : {},
                ...record.values && typeof record.values === "object" && !Array.isArray(record.values) ? { values: record.values } : {},
                ...record.schema ? { schema: record.schema } : {},
                ...record.data && typeof record.data === "object" && !Array.isArray(record.data) ? { data: record.data } : {}
              }
            };
          }
        }
      } catch (cause) {
        outcome = {
          succeeded: false,
          error: {
            code: "OPENUI_ACTION_UNREACHABLE",
            error: cause instanceof Error ? cause.message : "Could not reach the app. Try again.",
            actionId: action.id
          }
        };
      }
      pendingRef.current = null;
      setPendingActionId(null);
      if (outcome.succeeded) {
        const value = outcome.value;
        if (value.values) setValues(value.values);
        setMessage(value.message ?? null);
        setSchema(asNodes(value.schema));
        setData(value.data ?? null);
      } else {
        setError(outcome.error);
      }
      current.onResult?.(outcome);
      return outcome;
    },
    [setValues]
  );
  const onAction = useCallback(
    (action, context) => {
      void submit(action, context);
    },
    [submit]
  );
  return {
    values,
    setValue,
    setValues,
    resetValues,
    onAction,
    submit,
    pendingActionId,
    error,
    message,
    schema,
    data
  };
}
var OPENUI_RESERVED_BODY_KEYS = RESERVED_BODY_KEYS;
export {
  OPENUI_RESERVED_BODY_KEYS,
  useOpenUIActions
};
//# sourceMappingURL=index.js.map