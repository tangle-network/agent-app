import {
  AsyncView,
  MutationStatus,
  confirmWrite,
  rejectWrite,
  useAsyncResource,
  useConfirmedMutation
} from "../chunk-3UBAO3N5.js";

// src/channels/context.tsx
import { createContext, useContext } from "react";
import { jsx } from "react/jsx-runtime";
var Context = createContext(null);
function ChannelsProvider({ client, pollInterval = 3e3, children }) {
  if (pollInterval !== false && (!Number.isFinite(pollInterval) || pollInterval < 100)) {
    throw new Error("ChannelsProvider pollInterval must be false or at least 100 ms.");
  }
  return /* @__PURE__ */ jsx(Context.Provider, { value: { client, pollInterval }, children }, client.scope);
}
function useChannelsClient() {
  return useChannelsContext().client;
}
function useChannelsContext() {
  const value = useContext(Context);
  if (!value) throw new Error("Channel components and hooks require ChannelsProvider.");
  return value;
}

// src/channels/hooks.ts
import { useCallback, useEffect, useRef } from "react";
function useChannelResource(load, deps, enabled = true, poll = true) {
  const { client, pollInterval } = useChannelsContext();
  const resource = useAsyncResource({ load, deps: [client, client.scope, ...deps], enabled });
  useEffect(() => {
    if (!enabled || !poll || pollInterval === false || resource.status === "loading" || resource.status === "idle") return;
    const delay = typeof document !== "undefined" && document.hidden ? Math.max(15e3, pollInterval) : pollInterval;
    const timer = setTimeout(resource.retry, delay);
    return () => clearTimeout(timer);
  }, [enabled, poll, pollInterval, resource.status, resource.retry, resource]);
  return enabled ? resource : { status: "idle", retry: resource.retry };
}
function useChannelMutation(mutate, onSucceeded) {
  const { client } = useChannelsContext();
  const lock = useRef(null);
  const mutation = useConfirmedMutation({
    mutate: async (input, context) => confirmWrite(await mutate(input, context)),
    onSucceeded
  });
  const { reset, run } = mutation;
  useEffect(() => {
    reset();
    return () => {
      lock.current = null;
      reset();
    };
  }, [client, client.scope, reset]);
  const singleRun = useCallback(async (input) => {
    if (lock.current) return rejectWrite("Another channel operation is still in progress.");
    const token = {};
    lock.current = token;
    try {
      return await run(input);
    } finally {
      if (lock.current === token) lock.current = null;
    }
  }, [run]);
  return { ...mutation, run: singleRun };
}
function useChannels() {
  const { client } = useChannelsContext();
  return useChannelResource(() => client.lines.list(), []);
}
function useChannelConnections(transport) {
  const { client } = useChannelsContext();
  return useChannelResource((context) => client.setup.connections(transport, context), [transport], true, false);
}
function useWhatsAppNumbers(connectionId) {
  const { client } = useChannelsContext();
  return useChannelResource((context) => client.setup.whatsappNumbers(connectionId, context), [connectionId], !!connectionId, false);
}
function useConnectChannel(onConnected) {
  const { client } = useChannelsContext();
  return useChannelMutation(async (input) => {
    if (input.kind === "connection") {
      if (!input.input.connectionId.trim()) throw new Error("Choose a connection.");
      if (input.input.transport === "whatsapp" && !input.input.phoneNumberId.trim()) throw new Error("Choose a WhatsApp number.");
      return client.lines.fromConnection(input.input);
    }
    if (input.kind === "order") {
      if (!input.orderId.trim()) throw new Error("Choose a number order.");
      return client.setup.fromOrder(input.orderId);
    }
    const address = input.address.trim().toLowerCase();
    if (!input.connectionId.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error("Choose a connection and enter a valid mailbox address.");
    return client.setup.fromEmail({ connectionId: input.connectionId, address });
  }, onConnected);
}
function verificationExpired(test, now = Date.now()) {
  return test.expired || test.status !== "verified" && test.expiresAt <= now;
}
function useChannel(lineId) {
  const { client } = useChannelsContext();
  const resource = useChannelResource(async (context) => {
    const [line, verification] = await Promise.all([client.lines.get(lineId), client.setup.verification(lineId, context)]);
    if (line.id !== lineId || line.attachment && line.attachment.lineId !== lineId || verification && verification.lineId !== lineId) throw new Error("Channel binding changed. Reload channel setup.");
    return { line, verification };
  }, [lineId], !!lineId);
  const mutation = useChannelMutation(async ({ action, confirm }) => {
    if (resource.status !== "ready") throw new Error("Read the current channel state before changing it.");
    const { line, verification: test } = resource.value;
    if (line.id !== lineId) throw new Error("Channel binding changed. Reload channel setup.");
    if (action !== "reset" && line.status !== "active") throw new Error("This line is not active.");
    if (action === "start") {
      if (test && test.status !== "revoked") throw new Error("Stop the existing test before starting another.");
      await client.setup.start(lineId);
      return;
    }
    if (!test || test.lineId !== lineId) throw new Error("Start a channel test first.");
    if (action === "reset") {
      if (confirm !== true) throw new Error("Confirm stopping this test.");
      await client.setup.reset(lineId, test.id);
      return;
    }
    if (verificationExpired(test)) throw new Error("This test expired. Stop it and start a new test.");
    if (action === "activate") {
      if (test.status !== "verified") throw new Error("Verify inbound delivery and the test reply before activation.");
      const activated = await client.setup.activate(lineId, test.id);
      if (activated.id !== lineId || activated.status !== "active" || activated.attachment?.status !== "active" || activated.attachment.lineId !== lineId) throw new Error("Messaging activation was not confirmed.");
    } else if (action === "send") {
      if (test.status !== "received") throw new Error("Wait for the inbound test message before sending a reply.");
      await client.setup.send(lineId, test.id);
    } else {
      if (test.status !== "configuring" && test.status !== "uncertain") throw new Error("This test is not waiting for a setup check.");
      await client.setup.resume(lineId, test.id);
    }
  }, resource.retry);
  useEffect(() => mutation.reset(), [lineId, mutation.reset]);
  return { resource, ...mutation };
}
function useChannelConversations(lineId) {
  const { client } = useChannelsContext();
  return useChannelResource(async () => {
    const threads = await client.lines.threads(lineId).list();
    if (threads.some((thread) => thread.lineId !== lineId)) throw new Error("The thread response belongs to another line.");
    return threads;
  }, [lineId], !!lineId);
}
function useChannelConversation(lineId, threadId) {
  const { client } = useChannelsContext();
  return useChannelResource(async () => {
    const messages = await client.lines.threads(lineId).messages(threadId);
    if (messages.some((message) => message.threadId !== threadId)) throw new Error("The message response belongs to another conversation.");
    return [...new Map(messages.map((message) => [message.id, message])).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }, [lineId, threadId], !!lineId && !!threadId);
}

// src/channels/components.tsx
import { useEffect as useEffect3, useId, useState as useState2 } from "react";

// src/channels/numbers.ts
import { useEffect as useEffect2, useRef as useRef2, useState } from "react";
var NUMBER_CHARGE_NOTICE = "This is a one-time activation charge. Tangle does not bill recurring carrier rental for this number. Your provider\u2019s message rates are separate.";
var NUMBER_RETRY_NOTICE = "Retry uses the same approved quote, not a new purchase. Do not order again while the result is unknown.";
function holdsNumber(order) {
  return order.cancellation !== "released" && order.cancellation !== "abandoned";
}
function numberStage(order) {
  if (order.cancellation === "released" || order.cancellation === "abandoned") return "Released";
  if (order.cancellation === "needs_review") return "Release needs review";
  if (order.cancellation === "requested" || order.status === "cancelled") return "Cancelling";
  if (order.status === "needs_review") return "Needs operator review";
  if (order.status === "ready_for_setup") return "Number acquired \u2014 channel setup next";
  if (order.errorCode === "funding_required") return "Add funds to continue";
  if (order.errorCode === "sms_not_ready") return "Waiting for SMS activation";
  return "Provisioning";
}
function useNumberChannel(transport) {
  const { client } = useChannelsContext();
  const ordering = client.ordering;
  const reference = ordering?.references[transport];
  const [quote, setQuote] = useState(null);
  const [receipts, setReceipts] = useState([]);
  const [uncertain, setUncertain] = useState(false);
  const attempted = useRef2(false);
  const resource = useChannelResource(async ({ signal }) => {
    if (!ordering || !reference) throw new Error("Number ordering is unavailable.");
    const readiness = await ordering.numbers.readiness();
    const orders2 = [];
    const seen = /* @__PURE__ */ new Set();
    let cursor;
    let complete = false;
    do {
      if (signal.aborted) throw new Error("Number read was superseded.");
      const page = await ordering.numbers.list({ clientReference: reference, cursor, limit: 100 });
      if (page.orders.some((order) => order.clientReference !== reference || order.transport !== transport)) throw new Error("The number list belongs to another binding.");
      orders2.push(...page.orders);
      if (page.nextCursor == null) {
        complete = page.nextCursor === null;
        break;
      }
      if (seen.has(page.nextCursor) || seen.size >= 100) throw new Error("The number list could not be read completely.");
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    } while (cursor);
    return { readiness, orders: orders2, complete };
  }, [ordering, reference, transport], !!ordering);
  const loaded = resource.status === "ready" ? resource.value : null;
  const orders = [...new Map([...loaded?.orders ?? [], ...receipts].map((order) => [order.id, order])).values()];
  const held = orders.find(holdsNumber) ?? null;
  const mutation = useChannelMutation(async (input, { signal }) => {
    if (!ordering || !reference) throw new Error("Number ordering is unavailable.");
    if (input.action === "quote") {
      if (attempted.current) throw new Error("The previous purchase is unresolved. Retry its approved quote or check progress.");
      if (!loaded?.complete || !loaded.readiness.configured || !loaded.readiness.transports.includes(transport)) throw new Error("Number availability and existing orders must be confirmed first.");
      if (held) throw new Error("This agent already holds a number order for this transport.");
      const { quote: next } = await ordering.numbers.quote({ transport, clientReference: reference });
      if (next.transport !== transport || next.clientReference !== void 0 && next.clientReference !== reference) throw new Error("The quote belongs to another binding.");
      if (!signal.aborted) setQuote(next);
      return;
    }
    if (input.action === "purchase") {
      if (!quote || !input.consent) throw new Error("Approve the quoted activation charge before ordering.");
      if (!quote.terms.trim() || !Number.isSafeInteger(quote.activationCents) || quote.activationCents < 0 || !quote.token) throw new Error("A valid price and published activation terms are required.");
      if (held) throw new Error("This agent already holds a number order for this transport.");
      if (!attempted.current && (!loaded?.complete || !loaded.readiness.configured || quote.expiresAt <= Date.now())) throw new Error("The quote or order information expired. Read the current state first.");
      attempted.current = true;
      try {
        const { order: order2 } = await ordering.numbers.create({ quoteToken: quote.token, consent: true, clientReference: reference, transport });
        if (order2.clientReference !== reference || order2.transport !== transport) throw new Error("The purchase response belongs to another binding. Check progress before ordering again.");
        if (!signal.aborted) {
          setReceipts((current) => [order2, ...current.filter((item) => item.id !== order2.id)]);
          setQuote(null);
          setUncertain(false);
        }
      } catch (error) {
        if (!signal.aborted) setUncertain(true);
        throw error;
      } finally {
        if (!signal.aborted) resource.retry();
      }
      return;
    }
    if (!orders.some((order2) => order2.id === input.orderId)) throw new Error("Read this number order before changing it.");
    if (input.action === "cancel" && !input.confirm) throw new Error("Confirm cancelling this number.");
    const { order } = await ordering.numbers[input.action](input.orderId);
    if (order.id !== input.orderId || order.clientReference !== reference || order.transport !== transport) throw new Error("The number response belongs to another binding.");
    if (!signal.aborted) {
      setReceipts((current) => [order, ...current.filter((item) => item.id !== order.id)]);
      resource.retry();
    }
  });
  useEffect2(() => {
    setQuote(null);
    setReceipts([]);
    setUncertain(false);
    attempted.current = false;
    mutation.reset();
  }, [client, client.scope, transport, reference, mutation.reset]);
  useEffect2(() => {
    if (loaded) setReceipts((current) => current.filter((receipt) => !loaded.orders.some((order) => order.id === receipt.id)));
    if (loaded?.orders.some(holdsNumber)) {
      setQuote(null);
      setUncertain(false);
      attempted.current = false;
    } else if (!uncertain && !quote && loaded?.complete && orders.length > 0 && orders.every((order) => !holdsNumber(order))) {
      attempted.current = false;
    }
  }, [loaded]);
  return { resource, orders, held, quote, uncertain, ...mutation };
}

// src/channels/ui.tsx
import { jsx as jsx2 } from "react/jsx-runtime";
var panelClass = "space-y-4 rounded-xl border border-border bg-card p-6 text-foreground";
var buttonClass = "inline-flex items-center justify-center rounded-md border border-border px-3 py-2 text-sm font-medium transition hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
var primaryButtonClass = `${buttonClass} border-primary bg-primary text-primary-foreground hover:bg-primary/90`;
var inputClass = "block w-full rounded-md border border-input bg-background px-3 py-2 text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";
function ChannelFailure({ state }) {
  return state.status === "failed" ? /* @__PURE__ */ jsx2(MutationStatus, { state, className: "text-sm text-destructive" }) : null;
}
function ChannelState({ resource, children, empty }) {
  return /* @__PURE__ */ jsx2(
    AsyncView,
    {
      state: resource,
      empty: { title: empty, action: { label: "Refresh", onClick: resource.retry } },
      loadingLabel: "Loading channel\u2026",
      retryLabel: "Try again",
      renderIdle: () => /* @__PURE__ */ jsx2("p", { className: "text-sm text-muted-foreground", children: "Choose a channel to continue." }),
      children
    }
  );
}

// src/channels/components.tsx
import { Fragment, jsx as jsx3, jsxs } from "react/jsx-runtime";
var labels = { imessage: "iMessage", whatsapp: "WhatsApp", sms: "SMS", email: "Email" };
function channelMessageLink(line, instruction) {
  if (line.transport === "email") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(line.address)) return null;
    return `mailto:${encodeURIComponent(line.address)}?subject=Channel%20test&body=${encodeURIComponent(instruction)}`;
  }
  const address = line.routerAddress ?? line.address;
  if (!/^\+[1-9]\d{7,14}$/.test(address)) return null;
  if (line.transport === "whatsapp") return `https://wa.me/${address.slice(1)}?text=${encodeURIComponent(instruction)}`;
  return `sms:${address}?body=${encodeURIComponent(line.connect ?? instruction)}`;
}
function CopyLine({ text }) {
  const [message, setMessage] = useState2("");
  return /* @__PURE__ */ jsxs("div", { className: "space-y-2", children: [
    /* @__PURE__ */ jsxs("div", { className: "flex items-start gap-2 rounded-md bg-muted p-3", children: [
      /* @__PURE__ */ jsx3("code", { className: "min-w-0 flex-1 break-all", children: text }),
      /* @__PURE__ */ jsx3("button", { type: "button", className: buttonClass, "aria-label": `Copy ${text}`, onClick: async () => {
        try {
          await navigator.clipboard.writeText(text);
          setMessage("Copied");
        } catch {
          setMessage("Copy is unavailable. Select and copy the displayed text.");
        }
      }, children: "Copy" })
    ] }),
    message && /* @__PURE__ */ jsx3("p", { role: "status", className: "text-sm", children: message })
  ] });
}
function ChannelVerificationPanel({ lineId, className = "" }) {
  const channel = useChannel(lineId);
  const [confirming, setConfirming] = useState2(false);
  useEffect3(() => setConfirming(false), [lineId]);
  const busy = channel.state.status === "pending";
  const act = (action) => void channel.run({ action });
  return /* @__PURE__ */ jsxs("section", { className: `${panelClass} ${className}`, "aria-label": "Channel verification", "aria-busy": busy, children: [
    /* @__PURE__ */ jsx3("h2", { className: "text-lg font-semibold", children: "Verify this channel" }),
    /* @__PURE__ */ jsx3(ChannelState, { resource: channel.resource, empty: "The channel is unavailable.", children: ({ line, verification: test }) => {
      const expired = test ? verificationExpired(test) : false;
      const active = line.status === "active" && line.attachment?.status === "active";
      const link = test ? channelMessageLink(line, test.instruction) : null;
      return /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsxs("p", { className: "break-all font-medium", children: [
          labels[line.transport],
          " \xB7 ",
          line.address
        ] }),
        line.status !== "active" ? /* @__PURE__ */ jsxs("p", { role: "alert", children: [
          "This line is ",
          line.status,
          ". Check the line\u2019s status before testing or activating it."
        ] }) : active && test?.status === "verified" && !expired ? /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsxs("p", { role: "status", children: [
            "Both directions verified. Answering ",
            labels[line.transport],
            " messages."
          ] }),
          /* @__PURE__ */ jsx3("p", { children: line.connect && line.routerAddress ? `Share this: send ${line.connect} to ${line.routerAddress}.` : "Share this channel address so people can start a conversation." }),
          /* @__PURE__ */ jsx3(CopyLine, { text: line.connect ?? line.address })
        ] }) : !test || test.status === "revoked" ? /* @__PURE__ */ jsxs(Fragment, { children: [
          active && /* @__PURE__ */ jsx3("p", { children: "Attached to an agent, but no completed delivery test was returned." }),
          /* @__PURE__ */ jsx3("p", { children: "Test inbound delivery and a reply before this agent answers people." }),
          /* @__PURE__ */ jsx3("button", { type: "button", className: primaryButtonClass, disabled: busy, onClick: () => act("start"), children: "Start channel test" })
        ] }) : expired ? /* @__PURE__ */ jsx3("p", { role: "alert", children: "This test expired. Stop it before starting a new test." }) : test.status === "verified" ? /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsx3("p", { children: "Both directions verified. Messaging is not turned on yet." }),
          /* @__PURE__ */ jsx3("button", { type: "button", className: primaryButtonClass, disabled: busy, onClick: () => act("activate"), children: "Turn on messaging" })
        ] }) : test.status === "configuring" ? /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsx3("p", { children: "Connecting incoming messages to Tangle." }),
          /* @__PURE__ */ jsx3("button", { type: "button", className: primaryButtonClass, disabled: busy, onClick: () => act("resume"), children: "Check setup" })
        ] }) : test.status === "waiting" ? /* @__PURE__ */ jsxs(Fragment, { children: [
          line.connect && line.routerAddress && /* @__PURE__ */ jsxs(Fragment, { children: [
            /* @__PURE__ */ jsxs("p", { children: [
              "First, send this to ",
              line.routerAddress,
              ". The router replies with your agent\u2019s number."
            ] }),
            /* @__PURE__ */ jsx3(CopyLine, { text: line.connect })
          ] }),
          /* @__PURE__ */ jsx3("p", { children: line.transport === "email" ? `From another email address, send this line to ${line.address}.` : line.connect ? "Then send this in the conversation the router opens:" : `From your phone, send this to ${line.address}:` }),
          /* @__PURE__ */ jsx3(CopyLine, { text: test.instruction }),
          link && /* @__PURE__ */ jsxs("a", { className: primaryButtonClass, href: link, target: line.transport === "whatsapp" ? "_blank" : void 0, rel: "noopener noreferrer", children: [
            "Open ",
            line.transport === "email" ? "Email" : line.transport === "whatsapp" ? "WhatsApp" : "Messages"
          ] })
        ] }) : test.status === "received" ? /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsx3("p", { role: "status", children: "Your test message arrived." }),
          /* @__PURE__ */ jsx3("button", { type: "button", className: primaryButtonClass, disabled: busy, onClick: () => act("send"), children: "Send test reply" })
        ] }) : test.status === "sending" ? /* @__PURE__ */ jsx3("p", { role: "status", children: "The test reply is being sent. Do not send another." }) : test.status === "uncertain" ? /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsx3("p", { role: "alert", children: "The reply result is uncertain. Check its status instead of sending another." }),
          /* @__PURE__ */ jsx3("button", { type: "button", className: primaryButtonClass, disabled: busy, onClick: () => act("resume"), children: "Check reply status" })
        ] }) : test.status === "needs_review" ? /* @__PURE__ */ jsx3("p", { role: "alert", children: "Incoming message setup needs operator review. No delivery success is claimed." }) : /* @__PURE__ */ jsx3("p", { children: "Reply with the CONFIRM line in the message you received, in the same conversation." }),
        test?.error && /* @__PURE__ */ jsx3("p", { role: "alert", className: "text-destructive", children: test.error }),
        test && test.status !== "revoked" && !(active && test.status === "verified" && !expired) && /* @__PURE__ */ jsx3(Fragment, { children: !confirming ? /* @__PURE__ */ jsx3("button", { type: "button", className: buttonClass, disabled: busy, onClick: () => setConfirming(true), children: "Stop this test" }) : /* @__PURE__ */ jsxs("fieldset", { className: "space-y-2", children: [
          /* @__PURE__ */ jsx3("legend", { children: "Stop this test and revoke its setup?" }),
          /* @__PURE__ */ jsx3("button", { type: "button", className: buttonClass, disabled: busy, onClick: async () => {
            const outcome = await channel.run({ action: "reset", confirm: true });
            if (outcome.succeeded) setConfirming(false);
          }, children: "Confirm stop" }),
          " ",
          /* @__PURE__ */ jsx3("button", { type: "button", className: buttonClass, disabled: busy, onClick: () => setConfirming(false), children: "Keep testing" })
        ] }) }),
        /* @__PURE__ */ jsx3("button", { type: "button", className: buttonClass, disabled: busy, onClick: channel.resource.retry, children: "Refresh channel status" })
      ] });
    } }),
    /* @__PURE__ */ jsx3(ChannelFailure, { state: channel.state })
  ] });
}
function ConnectionPicker({ transport, onConnected }) {
  const client = useChannelsClient();
  const connections = useChannelConnections(transport);
  const [connectionId, setConnectionId] = useState2("");
  const [numberId, setNumberId] = useState2("");
  const [address, setAddress] = useState2("");
  const [showNumbers, setShowNumbers] = useState2(false);
  const numbers = useWhatsAppNumbers(showNumbers ? connectionId : "");
  const connect = useConnectChannel(onConnected);
  const busy = connect.state.status === "pending";
  useEffect3(() => {
    setConnectionId("");
    setNumberId("");
    setShowNumbers(false);
    setAddress("");
  }, [client, transport]);
  useEffect3(() => {
    if (connections.status === "ready" && connections.value.length === 1) setConnectionId(connections.value[0].id);
  }, [connections]);
  useEffect3(() => {
    if (numbers.status === "ready" && numbers.value.length === 1) setNumberId(numbers.value[0].id);
  }, [numbers]);
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx3(ChannelState, { resource: connections, empty: "No eligible Hub connections. Connect an identity in your app\u2019s Integrations first.", children: (items) => /* @__PURE__ */ jsxs("form", { className: "space-y-4", onSubmit: (event) => {
      event.preventDefault();
      if (transport === "email") void connect.run({ kind: "email", connectionId, address });
      else if (transport === "whatsapp") void connect.run({ kind: "connection", input: { transport, connectionId, phoneNumberId: numberId } });
      else void connect.run({ kind: "connection", input: { transport, connectionId } });
    }, children: [
      /* @__PURE__ */ jsxs("label", { className: "block", children: [
        "Connection",
        /* @__PURE__ */ jsxs("select", { className: inputClass, value: connectionId, disabled: busy, onChange: (event) => {
          setConnectionId(event.target.value);
          setNumberId("");
          setShowNumbers(false);
        }, required: true, children: [
          /* @__PURE__ */ jsx3("option", { value: "", children: "Choose a connection" }),
          items.map((item) => /* @__PURE__ */ jsx3("option", { value: item.id, children: item.account ?? item.displayName }, item.id))
        ] })
      ] }),
      transport === "email" && /* @__PURE__ */ jsxs("label", { className: "block", children: [
        "Mailbox address",
        /* @__PURE__ */ jsx3("input", { className: inputClass, type: "email", required: true, value: address, disabled: busy, onChange: (event) => setAddress(event.target.value), placeholder: "hello@example.com" })
      ] }),
      transport === "whatsapp" && /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx3("button", { type: "button", className: buttonClass, disabled: !connectionId || busy, onClick: () => {
          setShowNumbers(true);
          numbers.retry();
        }, children: "Show owned numbers" }),
        showNumbers && /* @__PURE__ */ jsx3(ChannelState, { resource: numbers, empty: "This connection has no eligible WhatsApp numbers.", children: (owned) => /* @__PURE__ */ jsxs("label", { className: "block", children: [
          "WhatsApp number",
          /* @__PURE__ */ jsxs("select", { className: inputClass, required: true, value: numberId, disabled: busy, onChange: (event) => setNumberId(event.target.value), children: [
            /* @__PURE__ */ jsx3("option", { value: "", children: "Choose a number" }),
            owned.map((number) => /* @__PURE__ */ jsx3("option", { value: number.id, children: number.address }, number.id))
          ] })
        ] }) })
      ] }),
      /* @__PURE__ */ jsx3("p", { className: "text-sm text-muted-foreground", children: "Connect an owned line, then test both directions. Each person must message first. Permissions remain managed in Tangle Hub." }),
      /* @__PURE__ */ jsx3("button", { type: "submit", className: primaryButtonClass, disabled: busy || !connectionId || transport === "email" && !address.trim() || transport === "whatsapp" && (!numberId || !showNumbers || numbers.status !== "ready"), children: busy ? "Connecting\u2026" : "Connect channel" })
    ] }) }),
    /* @__PURE__ */ jsx3(ChannelFailure, { state: connect.state })
  ] });
}
function ChannelConnect({ transport, initialLineId = "", className = "" }) {
  const [selected, setSelected] = useState2(initialLineId);
  const lines = useChannels();
  const id = useId();
  useEffect3(() => setSelected(initialLineId), [transport, initialLineId]);
  return /* @__PURE__ */ jsxs("div", { className: `space-y-4 ${className}`, children: [
    /* @__PURE__ */ jsxs("section", { className: panelClass, "aria-label": `${labels[transport]} channel`, children: [
      /* @__PURE__ */ jsxs("h2", { className: "text-lg font-semibold", children: [
        "Connect ",
        labels[transport]
      ] }),
      transport === "imessage" && /* @__PURE__ */ jsx3("p", { children: "Use a free shared iMessage identity, or acquire a dedicated number. A shared identity requires a connect message to the router first." }),
      /* @__PURE__ */ jsx3(ChannelState, { resource: lines, empty: "No lines connected to this agent yet.", children: (all) => {
        const matching = all.filter((line) => line.transport === transport && line.status !== "released");
        return matching.length ? /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsx3("label", { htmlFor: id, children: "Existing line" }),
          /* @__PURE__ */ jsxs("select", { id, className: inputClass, value: selected, onChange: (event) => setSelected(event.target.value), children: [
            /* @__PURE__ */ jsx3("option", { value: "", children: "Choose or connect a line" }),
            matching.map((line) => /* @__PURE__ */ jsx3("option", { value: line.id, children: line.label ?? line.address }, line.id))
          ] })
        ] }) : /* @__PURE__ */ jsxs("p", { children: [
          "No ",
          labels[transport],
          " lines connected yet."
        ] });
      } }),
      !selected && transport !== "sms" && /* @__PURE__ */ jsx3(ConnectionPicker, { transport, onConnected: (line) => {
        setSelected(line.id);
        lines.retry();
      } }, transport),
      selected && /* @__PURE__ */ jsx3("button", { type: "button", className: buttonClass, onClick: () => setSelected(""), children: "Choose another line" })
    ] }),
    selected ? /* @__PURE__ */ jsx3(ChannelVerificationPanel, { lineId: selected }, selected) : (transport === "sms" || transport === "imessage") && /* @__PURE__ */ jsx3(NumberChannel, { transport })
  ] });
}
function IMessageChannel(props) {
  return /* @__PURE__ */ jsx3(ChannelConnect, { ...props, transport: "imessage" });
}
function WhatsAppChannel(props) {
  return /* @__PURE__ */ jsx3(ChannelConnect, { ...props, transport: "whatsapp" });
}
function EmailChannel(props) {
  return /* @__PURE__ */ jsx3(ChannelConnect, { ...props, transport: "email" });
}
function SMSChannel(props) {
  return /* @__PURE__ */ jsx3(ChannelConnect, { ...props, transport: "sms" });
}
function NumberChannel({ transport, className = "" }) {
  const client = useChannelsClient();
  const number = useNumberChannel(transport);
  const [consent, setConsent] = useState2(false);
  const [cancelId, setCancelId] = useState2(null);
  const [lineId, setLineId] = useState2("");
  const connect = useConnectChannel((line) => setLineId(line.id));
  useEffect3(() => {
    setConsent(false);
  }, [number.quote?.token]);
  useEffect3(() => {
    setCancelId(null);
    setLineId("");
    connect.reset();
  }, [transport, client, connect.reset]);
  const busy = number.state.status === "pending" || connect.state.status === "pending";
  const money = (cents) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
  return /* @__PURE__ */ jsxs("section", { className: `${panelClass} ${className}`, "aria-label": `${labels[transport]} number`, "aria-busy": busy, children: [
    /* @__PURE__ */ jsxs("h2", { className: "text-lg font-semibold", children: [
      "Get a ",
      labels[transport],
      " number"
    ] }),
    !client.ordering ? /* @__PURE__ */ jsx3("p", { children: "Number ordering is unavailable. Existing numbers are unchanged." }) : /* @__PURE__ */ jsx3(ChannelState, { resource: number.resource, empty: "Number availability has not been confirmed.", children: ({ readiness, complete }) => /* @__PURE__ */ jsxs(Fragment, { children: [
      !readiness.configured && /* @__PURE__ */ jsx3("p", { children: "New orders are disabled. Existing numbers still require separate cancellation." }),
      !complete && /* @__PURE__ */ jsx3("p", { role: "alert", children: "The order list is incomplete. New purchases are disabled until ownership can be confirmed." }),
      number.held && /* @__PURE__ */ jsx3("p", { children: "This agent already holds an order for this transport. Cancel and release it before ordering another." }),
      /* @__PURE__ */ jsx3("button", { type: "button", className: primaryButtonClass, disabled: busy || !complete || !readiness.configured || !readiness.transports.includes(transport) || !!number.held || number.uncertain, onClick: () => void number.run({ action: "quote" }), children: "See activation price" })
    ] }) }),
    number.quote && /* @__PURE__ */ jsxs("div", { className: "space-y-3 rounded-md border border-border p-4", children: [
      /* @__PURE__ */ jsxs("h3", { className: "font-medium", children: [
        "Activation \xB7 ",
        money(number.quote.activationCents)
      ] }),
      /* @__PURE__ */ jsx3("p", { className: "whitespace-pre-wrap", children: number.quote.terms || "Published activation terms are missing. Ordering is disabled." }),
      /* @__PURE__ */ jsx3("p", { children: NUMBER_CHARGE_NOTICE }),
      /* @__PURE__ */ jsxs("label", { className: "flex items-start gap-2", children: [
        /* @__PURE__ */ jsx3("input", { type: "checkbox", checked: consent, disabled: busy, onChange: (event) => setConsent(event.target.checked) }),
        "I authorize this one-time activation charge. The number is not live until channel setup is complete."
      ] }),
      !number.uncertain && number.quote.expiresAt <= Date.now() && /* @__PURE__ */ jsx3("p", { role: "alert", children: "This quote expired. Read a new activation price before ordering." }),
      /* @__PURE__ */ jsx3("button", { type: "button", className: primaryButtonClass, disabled: busy || !consent || !number.quote.terms.trim() || !number.uncertain && number.quote.expiresAt <= Date.now(), onClick: () => void number.run({ action: "purchase", consent }), children: number.uncertain ? "Retry approved purchase" : `Order for ${money(number.quote.activationCents)}` })
    ] }),
    number.uncertain && /* @__PURE__ */ jsxs("p", { role: "alert", children: [
      "The purchase response was lost or refused. Its outcome is not confirmed. ",
      NUMBER_RETRY_NOTICE
    ] }),
    number.orders.map((order) => /* @__PURE__ */ jsxs("article", { className: "space-y-3 rounded-md border border-border p-4", children: [
      /* @__PURE__ */ jsx3("h3", { className: "break-all font-medium", children: order.address ?? "Your number order" }),
      /* @__PURE__ */ jsx3("p", { children: numberStage(order) }),
      order.errorCode && /* @__PURE__ */ jsxs("p", { role: "status", children: [
        "Status: ",
        order.errorCode.replace(/_/g, " ")
      ] }),
      order.status === "ready_for_setup" && order.cancellation === "none" && /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx3("p", { children: "The number is acquired, not delivery-verified. Test it before connecting conversations." }),
        /* @__PURE__ */ jsx3("button", { type: "button", className: buttonClass, disabled: busy, onClick: () => void connect.run({ kind: "order", orderId: order.id }), children: "Test this number" })
      ] }),
      /* @__PURE__ */ jsx3("button", { type: "button", className: buttonClass, disabled: busy, onClick: () => void number.run({ action: "advance", orderId: order.id }), children: "Check progress" }),
      " ",
      order.cancellation === "none" && (cancelId !== order.id ? /* @__PURE__ */ jsx3("button", { type: "button", className: buttonClass, disabled: busy, onClick: () => setCancelId(order.id), children: "Cancel number" }) : /* @__PURE__ */ jsxs("fieldset", { className: "space-y-2", children: [
        /* @__PURE__ */ jsx3("legend", { children: "Cancel this number? Access will be removed. Paid activation is not automatically refunded." }),
        /* @__PURE__ */ jsx3("button", { type: "button", className: buttonClass, disabled: busy, onClick: async () => {
          const result = await number.run({ action: "cancel", orderId: order.id, confirm: true });
          if (result.succeeded) setCancelId(null);
        }, children: "Confirm cancellation" }),
        " ",
        /* @__PURE__ */ jsx3("button", { type: "button", className: buttonClass, disabled: busy, onClick: () => setCancelId(null), children: "Keep number" })
      ] }))
    ] }, order.id)),
    /* @__PURE__ */ jsx3("button", { type: "button", className: buttonClass, disabled: busy, onClick: number.resource.retry, children: "Refresh number status" }),
    /* @__PURE__ */ jsx3("p", { className: "text-sm text-muted-foreground", children: "SMS and iMessage are separate activations. Buying a number does not enable WhatsApp." }),
    /* @__PURE__ */ jsx3(ChannelFailure, { state: number.state }),
    /* @__PURE__ */ jsx3(ChannelFailure, { state: connect.state }),
    lineId && /* @__PURE__ */ jsx3(ChannelVerificationPanel, { lineId }, lineId)
  ] });
}
function ChannelConversation({ lineId, threadId, className = "" }) {
  const messages = useChannelConversation(lineId, threadId);
  return /* @__PURE__ */ jsxs("section", { className: `${panelClass} ${className}`, "aria-label": "Channel conversation", children: [
    /* @__PURE__ */ jsx3("h3", { className: "font-semibold", children: "Conversation" }),
    /* @__PURE__ */ jsx3(ChannelState, { resource: messages, empty: "No messages in this conversation yet.", children: (items) => /* @__PURE__ */ jsx3("ol", { role: "log", "aria-live": "polite", "aria-label": "Messages", className: "space-y-3", children: items.map((message) => /* @__PURE__ */ jsxs("li", { className: "space-y-1 rounded-md bg-muted p-3", "data-direction": message.direction, children: [
      /* @__PURE__ */ jsxs("p", { className: "text-xs text-muted-foreground", children: [
        message.direction === "in" ? "Incoming" : "Outgoing",
        " \xB7 ",
        message.kind,
        " \xB7 ",
        /* @__PURE__ */ jsx3("time", { dateTime: message.createdAt, children: message.createdAt })
      ] }),
      /* @__PURE__ */ jsx3("p", { className: "whitespace-pre-wrap break-words", children: message.text ?? "Non-text message" }),
      /* @__PURE__ */ jsxs("p", { className: "text-xs", children: [
        message.status,
        message.errorCode ? ` \xB7 ${message.errorCode}` : ""
      ] })
    ] }, message.id)) }) }),
    /* @__PURE__ */ jsx3("button", { type: "button", className: buttonClass, onClick: messages.retry, children: "Refresh messages" })
  ] });
}
function ChannelConversations({ lineId, className = "" }) {
  const threads = useChannelConversations(lineId);
  const [selected, setSelected] = useState2(null);
  const threadId = selected?.lineId === lineId ? selected.threadId : "";
  return /* @__PURE__ */ jsxs("div", { className: `space-y-4 ${className}`, children: [
    /* @__PURE__ */ jsxs("section", { className: panelClass, "aria-label": "Channel conversations", children: [
      /* @__PURE__ */ jsx3("h2", { className: "text-lg font-semibold", children: "Conversations" }),
      /* @__PURE__ */ jsx3(ChannelState, { resource: threads, empty: "No conversations yet. Members must message the line first.", children: (items) => /* @__PURE__ */ jsx3("nav", { "aria-label": "Choose a conversation", className: "flex flex-wrap gap-2", children: items.map((thread) => /* @__PURE__ */ jsxs("button", { type: "button", className: buttonClass, "aria-pressed": thread.id === threadId, onClick: () => setSelected({ lineId, threadId: thread.id }), children: [
        thread.memberId,
        " \xB7 ",
        thread.status
      ] }, thread.id)) }) })
    ] }),
    threadId && /* @__PURE__ */ jsx3(ChannelConversation, { lineId, threadId }, `${lineId}:${threadId}`)
  ] });
}

// src/channels/payment.tsx
import { useEffect as useEffect4, useState as useState3 } from "react";
import { Fragment as Fragment2, jsx as jsx4, jsxs as jsxs2 } from "react/jsx-runtime";
function safeCheckoutUrl(value) {
  if (/^\/(?!\/)/.test(value) && !/[\\\s]/.test(value)) return value;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Checkout returned an unsafe URL.");
  return url.href;
}
function useLinePayment(lineId) {
  const { client } = useChannelsContext();
  const resource = useChannelResource((context) => {
    if (!client.payment) throw new Error("Payments are unavailable for this line.");
    return client.payment.read(lineId, context);
  }, [lineId], !!lineId && !!client.payment);
  const mutation = useChannelMutation(async ({ consent }) => {
    if (!client.payment || resource.status !== "ready") throw new Error("Read the current allowance before checkout.");
    const { plan, allowance, terms } = resource.value;
    if (!consent || !terms.trim()) throw new Error("Accept the published terms before checkout.");
    if (!plan.configured || !plan.paid || !Number.isFinite(plan.paid.priceUsdMonthly) || plan.paid.priceUsdMonthly <= 0 || allowance.decision !== "paywall" || !allowance.paywall || allowance.tier !== "free") throw new Error("Checkout is not available for this allowance.");
    return safeCheckoutUrl((await client.payment.checkout(lineId)).url);
  });
  useEffect4(() => mutation.reset(), [lineId, mutation.reset]);
  return { resource, ...mutation, available: !!client.payment };
}
function LinePayPage({ lineId, className = "" }) {
  const payment = useLinePayment(lineId);
  const [consentedTerms, setConsentedTerms] = useState3(null);
  const currentTerms = payment.resource.status === "ready" ? JSON.stringify([lineId, payment.resource.value.terms, payment.resource.value.plan.paid]) : null;
  const consent = currentTerms !== null && consentedTerms === currentTerms;
  return /* @__PURE__ */ jsxs2("section", { className: `${panelClass} ${className}`, "aria-label": "Line subscription", children: [
    /* @__PURE__ */ jsx4("h2", { className: "text-lg font-semibold", children: "Your line plan" }),
    !payment.available ? /* @__PURE__ */ jsx4("p", { children: "Payments are unavailable for this line." }) : /* @__PURE__ */ jsx4(ChannelState, { resource: payment.resource, empty: "No plan is available.", children: (value) => /* @__PURE__ */ jsxs2(Fragment2, { children: [
      /* @__PURE__ */ jsx4("h3", { className: "font-medium", children: value.label }),
      /* @__PURE__ */ jsxs2("p", { children: [
        value.allowance.turns.used,
        " of ",
        value.allowance.turns.limit,
        " turns used today."
      ] }),
      value.allowance.tier === "paid" ? /* @__PURE__ */ jsxs2("p", { role: "status", children: [
        "Your paid allowance is active.",
        value.allowance.decision === "allowance_reached" ? " Its current limit is exhausted; another checkout cannot lift it." : ""
      ] }) : value.allowance.decision === "paywall" && value.plan.paid ? /* @__PURE__ */ jsxs2(Fragment2, { children: [
        /* @__PURE__ */ jsxs2("p", { children: [
          new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value.plan.paid.priceUsdMonthly),
          " per month \xB7 ",
          value.plan.paid.turnsPerDay,
          " turns per day."
        ] }),
        /* @__PURE__ */ jsx4("p", { className: "whitespace-pre-wrap", children: value.terms || "Plan terms are unavailable. Checkout is disabled." }),
        /* @__PURE__ */ jsxs2("label", { className: "flex items-start gap-2", children: [
          /* @__PURE__ */ jsx4("input", { type: "checkbox", checked: consent, onChange: (event) => setConsentedTerms(event.target.checked ? currentTerms : null) }),
          "I accept these subscription terms."
        ] }),
        /* @__PURE__ */ jsx4("button", { type: "button", className: primaryButtonClass, disabled: !consent || !value.terms.trim() || payment.state.status === "pending", onClick: () => void payment.run({ consent }), children: "Continue to checkout" }),
        /* @__PURE__ */ jsx4("p", { className: "text-sm text-muted-foreground", children: "Payment is confirmed by the server after settlement, not by returning to this page." })
      ] }) : /* @__PURE__ */ jsxs2("p", { children: [
        value.allowance.decision === "allowance_reached" ? "Your allowance is exhausted. Paying does not lift this limit today." : "Your current allowance is available.",
        " Resets at ",
        value.allowance.resetsAt,
        "."
      ] }),
      /* @__PURE__ */ jsx4("button", { type: "button", className: buttonClass, onClick: payment.resource.retry, children: "Check payment status" })
    ] }) }),
    payment.state.status === "succeeded" && consent && /* @__PURE__ */ jsx4("a", { className: "underline", href: payment.state.value, rel: "noopener noreferrer", children: "Open secure checkout" }),
    /* @__PURE__ */ jsx4(ChannelFailure, { state: payment.state })
  ] });
}
export {
  ChannelConnect,
  ChannelConversation,
  ChannelConversations,
  ChannelVerificationPanel,
  ChannelsProvider,
  EmailChannel,
  IMessageChannel,
  LinePayPage,
  NUMBER_CHARGE_NOTICE,
  NUMBER_RETRY_NOTICE,
  NumberChannel,
  SMSChannel,
  WhatsAppChannel,
  channelMessageLink,
  holdsNumber,
  numberStage,
  safeCheckoutUrl,
  useChannel,
  useChannelConnections,
  useChannelConversation,
  useChannelConversations,
  useChannels,
  useChannelsClient,
  useConnectChannel,
  useLinePayment,
  useNumberChannel,
  useWhatsAppNumbers,
  verificationExpired
};
//# sourceMappingURL=index.js.map