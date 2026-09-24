// src/spend/types.ts
var SPEND_CHECKS = [
  "unknown-box",
  "over-ceiling",
  "velocity",
  "negative-balance",
  "silent-ledger"
];

// src/spend/ownership.ts
function ownedByBillingKeys(keyIds) {
  const owned = new Set(keyIds.map((id) => id.trim()).filter(Boolean));
  if (owned.size === 0) {
    throw new Error(
      "ownedByBillingKeys needs at least one key id: a rule that owns no key classifies every settlement as another product's and reports a clean bill for an unchecked account."
    );
  }
  const label = `billing key ${[...owned].join(", ")}`;
  return {
    label,
    decide({ row }) {
      const keyId = row.keyId?.trim();
      if (!keyId) return "undecidable";
      return owned.has(keyId) ? "mine" : "foreign";
    }
  };
}
function decideBoxOwnership(rule, sandboxId, rows) {
  let verdict = "foreign";
  for (const row of rows) {
    const rowVerdict = rule.decide({ row, sandboxId });
    if (rowVerdict === "mine") return "mine";
    if (rowVerdict === "undecidable") verdict = "undecidable";
  }
  return verdict;
}

// src/spend/ceiling.ts
var DEFAULT_CEILING_TOLERANCE_MS = 9e5;
function computeExpectedCeiling(record, options) {
  const toleranceMs = options.toleranceMs ?? DEFAULT_CEILING_TOLERANCE_MS;
  const { asOf } = options;
  let basis;
  let horizonAt;
  if (record.deletedAt !== null) {
    basis = "deleted";
    horizonAt = record.deletedAt;
  } else if (record.stoppedAt !== null) {
    basis = "stopped";
    horizonAt = record.stoppedAt;
  } else if (record.openDetachedRunIds.length > 0) {
    basis = "open-detached-run";
    horizonAt = asOf;
  } else {
    basis = "idle-timeout";
    horizonAt = record.lastActivityAt + record.idleTimeoutSeconds * 1e3;
  }
  if (record.maxLifetimeSeconds !== null) {
    const lifetimeHorizon = record.createdAt + record.maxLifetimeSeconds * 1e3;
    if (lifetimeHorizon < horizonAt) {
      basis = "max-lifetime";
      horizonAt = lifetimeHorizon;
    }
  }
  if (horizonAt > asOf) horizonAt = asOf;
  if (horizonAt < record.createdAt) horizonAt = record.createdAt;
  return {
    sandboxId: record.sandboxId,
    basis,
    horizonAt,
    ceilingMs: horizonAt - record.createdAt + toleranceMs,
    toleranceMs,
    bounded: basis !== "open-detached-run"
  };
}

// src/spend/liveness.ts
var DEFAULT_EXPECTATION_GRACE_MS = 9e5;
function assertSpendWindow(window) {
  if (!Number.isFinite(window.startAt) || !Number.isFinite(window.endAt)) {
    throw new Error("spend window needs finite `startAt` and `endAt` epoch-ms instants");
  }
  if (window.endAt <= window.startAt) {
    throw new Error(
      `spend window ends at or before it starts (${new Date(window.startAt).toISOString()} \u2192 ${new Date(window.endAt).toISOString()}): a zero-width window expects nothing and would certify an unchecked account.`
    );
  }
}
function boxLivenessInWindow(record, window, options = {}) {
  const graceMs = options.graceMs ?? DEFAULT_EXPECTATION_GRACE_MS;
  const ceiling = computeExpectedCeiling(record, { asOf: window.endAt, toleranceMs: 0 });
  const liveFrom = record.createdAt;
  const liveUntil = ceiling.horizonAt;
  const overlaps = liveFrom <= window.endAt && liveUntil >= window.startAt;
  const overlapStart = Math.max(liveFrom, window.startAt);
  const overlapEnd = Math.min(liveUntil, window.endAt);
  const liveMsInWindow = overlaps ? Math.max(0, overlapEnd - overlapStart) : 0;
  return {
    sandboxId: record.sandboxId,
    workspaceId: record.workspaceId,
    liveFrom,
    liveUntil,
    basis: ceiling.basis,
    overlaps,
    liveMsInWindow,
    expectSettlement: overlaps && liveMsInWindow >= graceMs
  };
}
function assessAllExcluded(report) {
  const { ownership, expectation } = report;
  if (report.boxesExamined === 0 || ownership.ownedBoxes > 0) {
    return {
      pathological: false,
      basis: "not-all-excluded",
      reason: `${report.boxesExamined} box(es) examined, ${ownership.ownedBoxes} claimed as this product's \u2014 this pass looked at its own settlements.`
    };
  }
  if (!expectation.declared) {
    return {
      pathological: true,
      basis: "not-declared",
      reason: `every one of the ${report.boxesExamined} settled box(es) was excluded as another product's, and no expectation was declared \u2014 so an over-narrow ownership rule and a genuinely idle product are indistinguishable here. Raised fail-closed; declare \`window\` and implement \`listLiveBetween\` on the expectation store to make this answerable.`
    };
  }
  if (expectation.expectedBoxes === 0) {
    return {
      pathological: false,
      basis: "nothing-expected",
      reason: `every one of the ${report.boxesExamined} settled box(es) was excluded as another product's, and this product had no box live in the window (${expectation.liveBoxes} overlapping, 0 live long enough to expect a bill) \u2014 an idle product beside a busy sibling, not a broken rule.`
    };
  }
  return {
    pathological: true,
    basis: "expected-boxes-live",
    reason: `every one of the ${report.boxesExamined} settled box(es) was excluded as another product's (${ownership.label ?? "no rule"}) while this product had ${expectation.expectedBoxes} box(es) live in the window \u2014 its own settlements should have been in there.`
  };
}
function undeclaredExpectation(graceMs) {
  return {
    declared: false,
    window: null,
    graceMs,
    liveBoxes: 0,
    expectedBoxes: 0,
    settledBoxes: 0,
    unsettledSandboxIds: []
  };
}

// src/spend/reference.ts
function parseSettlementReference(referenceId) {
  if (!referenceId) return null;
  const parts = referenceId.split(":");
  if (parts.length < 3 || parts[0] !== "sandbox") return null;
  const kind = parts[1];
  if (!kind) return null;
  const tail = parts[parts.length - 1];
  const tailMs = /^\d+$/.test(tail) ? Number(tail) : Number.NaN;
  const hasCursor = parts.length >= 4 && Number.isSafeInteger(tailMs) && tailMs > 0;
  const resourceId = hasCursor ? parts.slice(2, -1).join(":") : parts.slice(2).join(":");
  if (!resourceId) return null;
  return { kind, resourceId, intervalStartMs: hasCursor ? tailMs : null };
}
function parseSandboxGroupKey(groupKey) {
  if (!groupKey) return null;
  const parts = groupKey.split(":");
  if (parts.length < 2 || parts[0] !== "sandbox") return null;
  const id = parts.slice(1).join(":");
  return id || null;
}
function settlementSandboxId(row) {
  const reference = parseSettlementReference(row.referenceId);
  if (reference && reference.intervalStartMs !== null) return reference.resourceId;
  return parseSandboxGroupKey(row.groupKey) ?? (reference ? reference.resourceId : null);
}
function isCharge(row) {
  return row.amountNanoUsd < 0;
}
function chargeNanoUsd(row) {
  return row.amountNanoUsd < 0 ? -row.amountNanoUsd : 0;
}

// src/spend/reconcile.ts
var NANO_PER_USD = 1e9;
var MS_PER_HOUR = 36e5;
var DEFAULT_VELOCITY = {
  windowMs: 864e5,
  multiple: 5,
  minTrailingWindows: 3,
  minAbsoluteNanoUsd: NANO_PER_USD
};
function usd(nano) {
  return `$${(nano / NANO_PER_USD).toFixed(2)}`;
}
function hours(ms) {
  return `${(ms / MS_PER_HOUR).toFixed(1)}h`;
}
var BASIS_TRUST = ["unknown", "reference-span", "rate", "reported"];
function weakestBasis(a, b) {
  return BASIS_TRUST.indexOf(a) <= BASIS_TRUST.indexOf(b) ? a : b;
}
function resolveBilledMs(row, ratePerHourNano) {
  if (row.billedMs !== null) return { ms: row.billedMs, basis: "reported" };
  const charge = chargeNanoUsd(row);
  if (ratePerHourNano !== null && ratePerHourNano > 0 && charge > 0) {
    return { ms: charge / ratePerHourNano * MS_PER_HOUR, basis: "rate" };
  }
  const reference = parseSettlementReference(row.referenceId);
  if (reference?.intervalStartMs != null && row.createdAt > reference.intervalStartMs) {
    return { ms: row.createdAt - reference.intervalStartMs, basis: "reference-span" };
  }
  return { ms: 0, basis: "unknown" };
}
function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}
function unknownBoxAttribution(ownership, verdict) {
  if (!ownership) {
    return " No ownership rule was declared for this pass, so a sibling product's box on the same wallet reads exactly like a charge that is not ours \u2014 this finding could be either.";
  }
  if (verdict === "undecidable") {
    return ` The ownership rule (${ownership.label}) could not decide it: the settlement carries no billing-key attribution to exclude it by, so it is reported rather than dropped.`;
  }
  return ` The ownership rule (${ownership.label}) attributes it to THIS product.`;
}
function unknownBoxRemedy(ownership, verdict, sandboxId) {
  const lookup = `Look up ${sandboxId} on the platform before disputing.`;
  if (!ownership) {
    return `Declare \`ownership\` (see \`ownedByBillingKeys\`) so a sibling product's box stops reading as a discrepancy \u2014 without it this check cannot tell one from a charge that is not ours. Until then, treat this as one of three things: a sibling product on the same wallet, a box provisioned outside the recorded seam, or a box that is not ours at all. ${lookup}`;
  }
  if (verdict === "undecidable") {
    return `An unattributable charge on a shared wallet is exactly what a phantom charge looks like, so it is reported by design rather than excluded. Confirm the row genuinely predates key attribution before dismissing it. ${lookup}`;
  }
  return `This box is inside this product's own billing attribution and the product never recorded it, so it is either a provision that bypassed the recorded seam or a charge that is not ours. ${lookup}`;
}
function emptyFinding(check) {
  return {
    check,
    sandboxId: null,
    workspaceId: null,
    referenceIds: [],
    settledNanoUsd: 0,
    settledMs: null,
    durationBasis: null,
    ceilingMs: null,
    overageMs: null,
    ceilingBasis: null,
    windowNanoUsd: null,
    trailingMedianNanoUsd: null,
    velocityRatio: null,
    windowStartAt: null,
    windowEndAt: null,
    balanceNanoUsd: null,
    balanceFloorNanoUsd: null,
    expectedBoxes: null,
    settledBoxes: null,
    liveMsInWindow: null
  };
}
function iso(at) {
  return new Date(at).toISOString();
}
function silentLedgerFindings(input) {
  const { expectation, unsettled, ownership, workspaceId } = input;
  const scope = ownership ? `the ownership rule (${ownership.label})` : "no ownership rule (none declared)";
  if (input.coverage === "unverified") {
    return [
      {
        ...emptyFinding("silent-ledger"),
        workspaceId,
        expectedBoxes: 0,
        settledBoxes: 0,
        message: `This pass examined none of this product's settlements \u2014 ${input.rowsExamined} row(s) read, ${input.boxesExamined} box(es), ${input.foreignBoxes} excluded by ${scope}, 0 claimed as this product's \u2014 and no expectation was declared, so it cannot tell a genuinely idle window from a check that stopped checking. A clean bill is not one of the answers available here.`,
        remedy: "Declare `window` and implement `listLiveBetween` on the expectation store, so this pass can state what it EXPECTED to be billed for and an empty result becomes an answer instead of a silence. Until then, verify the ledger fetch by hand for this window before treating the account as checked."
      }
    ];
  }
  if (unsettled.length === 0) return [];
  const window = expectation.window;
  const span = window ? ` in the window ${iso(window.startAt)} \u2192 ${iso(window.endAt)}` : "";
  if (unsettled.length === expectation.expectedBoxes) {
    return [
      {
        ...emptyFinding("silent-ledger"),
        workspaceId,
        expectedBoxes: expectation.expectedBoxes,
        settledBoxes: 0,
        ...window ? { windowStartAt: window.startAt, windowEndAt: window.endAt } : {},
        message: `Nothing settled against ANY of the ${expectation.expectedBoxes} box(es) this product had live${span}, out of ${expectation.liveBoxes} that overlapped it. ${input.rowsExamined} row(s) were read and ${input.foreignBoxes} box(es) excluded by ${scope}. A window in which this product ran boxes and was billed for none of them is far more likely to be a broken check than a free week \u2014 an empty or mis-scoped ledger fetch, a rotated key the ownership rule does not name, or a feed that quietly stopped returning rows all produce exactly this shape. Treat this report as unverified, not as clean.`,
        remedy: `Check the fetch before the bill: re-run the transactions query for this exact window by hand and compare the row count with \`rowsExamined\` above. If the rows are there, the ownership rule is excluding them \u2014 compare its key ids against the key the boxes were created under. Boxes expected: ${expectation.unsettledSandboxIds.join(", ")}.`
      }
    ];
  }
  return unsettled.map((box) => ({
    ...emptyFinding("silent-ledger"),
    sandboxId: box.sandboxId,
    workspaceId: box.workspaceId || workspaceId,
    expectedBoxes: expectation.expectedBoxes,
    settledBoxes: expectation.settledBoxes,
    liveMsInWindow: box.liveMsInWindow,
    ...window ? { windowStartAt: window.startAt, windowEndAt: window.endAt } : {},
    message: `Sandbox ${box.sandboxId} was live for ${hours(box.liveMsInWindow)}${span} and nothing settled against it, while ${expectation.settledBoxes} of this product's other expected box(es) settled normally. Its life ended on basis ${box.basis} at ${iso(box.liveUntil)}.`,
    remedy: `One silent box beside working siblings is not a discount. Check, in order: whether its settlement is merely late (the platform treats up to 900 s of compute-settlement lag as normal, and \`expectationGraceMs\` is the dial for it); whether this box was created under a key the ownership rule does not claim, so its charges are landing on another product's report; and whether the expectation ledger's own record for ${box.sandboxId} is stale.`
  }));
}
async function reconcileSpend(options) {
  const asOf = options.asOf ?? Date.now();
  const toleranceMs = options.toleranceMs ?? DEFAULT_CEILING_TOLERANCE_MS;
  const workspaceId = options.workspaceId ?? null;
  const skip = new Set(options.skip ?? []);
  const checksRun = SPEND_CHECKS.filter((check) => !skip.has(check));
  const runs = (check) => !skip.has(check);
  const ownership = options.ownership ?? null;
  const graceMs = options.expectationGraceMs ?? DEFAULT_EXPECTATION_GRACE_MS;
  if (options.window) assertSpendWindow(options.window);
  const findings = [];
  let settledNanoUsd = 0;
  let creditedNanoUsd = 0;
  let ownedBoxes = 0;
  let ownedNanoUsd = 0;
  let undecidableBoxes = 0;
  let foreignNanoUsd = 0;
  const foreignSandboxIds = [];
  const ownedSandboxIds = /* @__PURE__ */ new Set();
  const byBox = /* @__PURE__ */ new Map();
  for (const row of options.rows) {
    if (row.amountNanoUsd < 0) settledNanoUsd += -row.amountNanoUsd;
    else creditedNanoUsd += row.amountNanoUsd;
    if (row.amountNanoUsd >= 0) continue;
    const sandboxId = settlementSandboxId(row);
    if (!sandboxId) continue;
    const bucket = byBox.get(sandboxId);
    if (bucket) bucket.push(row);
    else byBox.set(sandboxId, [row]);
  }
  const rateOf = (record, sandboxId) => {
    const rate = options.nanoUsdPerHour;
    if (rate === void 0) return null;
    if (typeof rate === "number") return rate;
    return rate(record, sandboxId) ?? null;
  };
  for (const [sandboxId, rows] of byBox) {
    const record = await options.store.load(sandboxId);
    const referenceIds = rows.map((row) => row.referenceId ?? row.id);
    const charged = rows.reduce((sum, row) => sum + chargeNanoUsd(row), 0);
    const verdict = record ? "mine" : ownership ? decideBoxOwnership(ownership, sandboxId, rows) : "mine";
    if (verdict === "foreign") {
      foreignSandboxIds.push(sandboxId);
      foreignNanoUsd += charged;
      continue;
    }
    ownedBoxes += 1;
    ownedNanoUsd += charged;
    ownedSandboxIds.add(sandboxId);
    if (verdict === "undecidable") undecidableBoxes += 1;
    if (!record) {
      if (runs("unknown-box")) {
        findings.push({
          ...emptyFinding("unknown-box"),
          sandboxId,
          workspaceId,
          referenceIds,
          settledNanoUsd: charged,
          message: `${usd(charged)} settled across ${rows.length} row(s) against sandbox ${sandboxId}, which this product has no record of ever asking for.` + unknownBoxAttribution(ownership, verdict),
          remedy: unknownBoxRemedy(ownership, verdict, sandboxId)
        });
      }
      continue;
    }
    if (!runs("over-ceiling")) continue;
    const ceiling = computeExpectedCeiling(record, { asOf, toleranceMs });
    const ratePerHourNano = rateOf(record, sandboxId);
    let settledMs = 0;
    let basis = "reported";
    let anyMeasured = false;
    for (const row of rows) {
      const resolved = resolveBilledMs(row, ratePerHourNano);
      if (resolved.basis === "unknown") {
        basis = weakestBasis(basis, "unknown");
        continue;
      }
      anyMeasured = true;
      settledMs += resolved.ms;
      basis = weakestBasis(basis, resolved.basis);
    }
    if (!anyMeasured) continue;
    if (settledMs <= ceiling.ceilingMs) continue;
    const overageMs = settledMs - ceiling.ceilingMs;
    const confidence = ceiling.bounded ? "" : " The product could not bound this box from its own observations (an unfinished detached run, and no max lifetime), so the ceiling rests on the reconciliation instant: this settlement bills time outside the box's own life, not merely more than expected.";
    const spanCaveat = basis === "reference-span" ? " Duration is derived from the settlement instant minus the interval start, which overstates a settlement the platform merely posted late \u2014 confirm before disputing." : "";
    findings.push({
      ...emptyFinding("over-ceiling"),
      sandboxId,
      workspaceId: record.workspaceId || workspaceId,
      referenceIds,
      settledNanoUsd: charged,
      settledMs,
      durationBasis: basis,
      ceilingMs: ceiling.ceilingMs,
      overageMs,
      ceilingBasis: ceiling.basis,
      message: `Sandbox ${sandboxId} settled ${hours(settledMs)} (${usd(charged)}) across ${rows.length} row(s), against an expected ceiling of ${hours(ceiling.ceilingMs)} \u2014 over by ${hours(overageMs)}. Ceiling basis: ${ceiling.basis}; duration basis: ${basis}.` + confidence + spanCaveat,
      remedy: `Dispute ${referenceIds.join(", ")} against the platform ledger with both numbers. ` + (ceiling.basis === "stopped" || ceiling.basis === "deleted" ? "The product recorded this box as no longer running before the billed time ended, so either the stop did not take or the interval was settled at the wrong boundary." : "Freeze the open interval before anything deletes this box \u2014 deleting a box with an open compute interval settles the whole gap at once.")
    });
  }
  if (runs("velocity") && options.velocity !== false) {
    const cfg = { ...DEFAULT_VELOCITY, ...options.velocity ?? {} };
    const buckets = /* @__PURE__ */ new Map();
    for (const row of options.rows) {
      const charge = chargeNanoUsd(row);
      if (charge === 0) continue;
      if (ownership && ownership.decide({ row, sandboxId: settlementSandboxId(row) }) === "foreign") {
        continue;
      }
      const bucketStart = Math.floor(row.createdAt / cfg.windowMs) * cfg.windowMs;
      const bucket = buckets.get(bucketStart);
      if (bucket) {
        bucket.nano += charge;
        bucket.references.push(row.referenceId ?? row.id);
      } else {
        buckets.set(bucketStart, { nano: charge, references: [row.referenceId ?? row.id] });
      }
    }
    const ordered = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < ordered.length; i++) {
      const entry = ordered[i];
      if (!entry) continue;
      const [windowStartAt, bucket] = entry;
      if (i < cfg.minTrailingWindows) continue;
      const trailing = ordered.slice(0, i).map(([, prior]) => prior.nano);
      const trailingMedian = median(trailing);
      const threshold = Math.max(trailingMedian * cfg.multiple, cfg.minAbsoluteNanoUsd);
      if (bucket.nano <= threshold) continue;
      const ratio = trailingMedian > 0 ? bucket.nano / trailingMedian : Number.POSITIVE_INFINITY;
      findings.push({
        ...emptyFinding("velocity"),
        workspaceId,
        referenceIds: bucket.references,
        settledNanoUsd: bucket.nano,
        windowNanoUsd: bucket.nano,
        trailingMedianNanoUsd: trailingMedian,
        velocityRatio: ratio,
        windowStartAt,
        message: `${usd(bucket.nano)} settled in the window starting ${new Date(windowStartAt).toISOString()} across ${bucket.references.length} row(s), against a trailing median of ${usd(trailingMedian)} over ${trailing.length} prior window(s) \u2014 ${Number.isFinite(ratio) ? `${ratio.toFixed(1)}x` : "no prior spend to compare against"}, over the ${cfg.multiple}x threshold.` + (ownership ? ` Counted over this product's own rows only (${ownership.label}); the wallet total for the window is higher when a sibling product settled into it.` : " Counted over every row on the wallet, which on a shared account includes any sibling product's spend."),
        remedy: "A burst of this shape is what a settlement defect looks like from the consumer side: long-dormant intervals cashed out at once. Check whether these rows carry interval starts far older than the settlement instant before treating it as real usage."
      });
    }
  }
  if (runs("negative-balance") && options.balance) {
    const floor = options.balance.floorNanoUsd ?? 0;
    if (options.balance.nanoUsd < floor) {
      findings.push({
        ...emptyFinding("negative-balance"),
        workspaceId,
        settledNanoUsd: Math.max(0, floor - options.balance.nanoUsd),
        balanceNanoUsd: options.balance.nanoUsd,
        balanceFloorNanoUsd: floor,
        message: `Observed balance ${usd(options.balance.nanoUsd)} is below the floor ${usd(floor)}.`,
        remedy: "Stop provisioning new compute for this owner until the balance is explained. A negative balance that nobody is watching is how a billing defect becomes settled money."
      });
    }
  }
  const ownershipSummary = {
    declared: ownership !== null,
    label: ownership?.label ?? null,
    ownedBoxes,
    ownedNanoUsd,
    undecidableBoxes,
    foreignBoxes: foreignSandboxIds.length,
    foreignNanoUsd,
    foreignSandboxIds
  };
  const window = options.window ?? null;
  const canList = typeof options.store.listLiveBetween === "function";
  let expectation = undeclaredExpectation(graceMs);
  let unsettled = [];
  if (window && canList) {
    const candidates = await options.store.listLiveBetween(window);
    const live = candidates.map((record) => boxLivenessInWindow(record, window, { graceMs })).filter((box) => box.overlaps);
    const expected = live.filter((box) => box.expectSettlement);
    unsettled = expected.filter((box) => !ownedSandboxIds.has(box.sandboxId));
    expectation = {
      declared: true,
      window,
      graceMs,
      liveBoxes: live.length,
      expectedBoxes: expected.length,
      settledBoxes: expected.length - unsettled.length,
      unsettledSandboxIds: unsettled.map((box) => box.sandboxId)
    };
  }
  const coverage = ownedBoxes > 0 ? "verified" : expectation.declared ? expectation.expectedBoxes > 0 ? "verified" : "nothing-expected" : "unverified";
  if (runs("silent-ledger")) {
    findings.push(
      ...silentLedgerFindings({
        expectation,
        unsettled,
        coverage,
        ownership,
        workspaceId,
        rowsExamined: options.rows.length,
        boxesExamined: byBox.size,
        ownedBoxes,
        foreignBoxes: foreignSandboxIds.length
      })
    );
  }
  return {
    // `coverage` is the second half of the gate deliberately: skipping the
    // `silent-ledger` check removes its findings, never the verdict, so no
    // combination of options can make an examined-nobody pass report clean.
    ok: findings.length === 0 && coverage !== "unverified",
    coverage,
    findings,
    checksRun,
    rowsExamined: options.rows.length,
    boxesExamined: byBox.size,
    settledNanoUsd,
    creditedNanoUsd,
    ownership: ownershipSummary,
    expectation,
    asOf
  };
}

// src/spend/report.ts
var NANO_PER_USD2 = 1e9;
function usd2(nano) {
  return nano === null ? "\u2014" : `$${(nano / NANO_PER_USD2).toFixed(2)}`;
}
function formatSpendReport(report) {
  const lines = [];
  lines.push(
    `spend reconciliation \u2014 ${report.rowsExamined} row(s), ${report.boxesExamined} box(es), ${usd2(report.settledNanoUsd)} charged, ${usd2(report.creditedNanoUsd)} credited, as of ${new Date(report.asOf).toISOString()}`
  );
  lines.push(`checks: ${report.checksRun.join(", ") || "(none)"}`);
  for (const line of ownershipLines(report.ownership)) lines.push(line);
  for (const line of expectationLines(report.expectation)) lines.push(line);
  if (report.ok) {
    lines.push("");
    lines.push("OK \u2014 no discrepancy between the product's expectations and the settled ledger.");
    return lines.join("\n");
  }
  if (report.coverage === "unverified") {
    lines.push("");
    lines.push(
      `UNVERIFIED \u2014 this pass examined none of this product's settlements and could not say what it expected, so it cannot certify the bill either way. Read the finding below as "do not trust this report", not as "dispute this charge".`
    );
  }
  lines.push("");
  lines.push(`${report.findings.length} finding(s):`);
  for (const finding of report.findings) {
    lines.push("");
    lines.push(`  [${finding.check}] ${finding.message}`);
    for (const [label, value] of measuredFields(finding)) lines.push(`    ${label}: ${value}`);
    if (finding.referenceIds.length > 0) {
      lines.push(`    rows: ${finding.referenceIds.join(", ")}`);
    }
    lines.push(`    \u2192 ${finding.remedy}`);
  }
  return lines.join("\n");
}
function ownershipLines(ownership) {
  if (!ownership.declared) {
    return [
      `scope: NOT DECLARED \u2014 all ${ownership.ownedBoxes} settled box(es) claimed as this product's. A sibling product's box on this wallet is reported as unknown-box; pass \`ownership\` (see \`ownedByBillingKeys\`) to tell the two apart.`
    ];
  }
  const lines = [
    `scope: ${ownership.label} \u2014 ${ownership.ownedBoxes} box(es) ${usd2(ownership.ownedNanoUsd)} owned, ${ownership.foreignBoxes} box(es) ${usd2(ownership.foreignNanoUsd)} excluded as another product's`
  ];
  if (ownership.undecidableBoxes > 0) {
    lines.push(
      `       ${ownership.undecidableBoxes} of the owned box(es) carried no billing-key attribution and were claimed fail-closed`
    );
  }
  if (ownership.foreignSandboxIds.length > 0) {
    lines.push(`       excluded: ${ownership.foreignSandboxIds.join(", ")}`);
  }
  return lines;
}
function expectationLines(expectation) {
  if (!expectation.declared) {
    return [
      "expectation: NOT DECLARED \u2014 this pass is driven entirely by the settlement rows it was handed, so it can say nothing about a box it asked for and was never billed for. Pass `window` and implement `listLiveBetween` on the expectation store to close that direction."
    ];
  }
  const window = expectation.window;
  const span = window ? `${new Date(window.startAt).toISOString()} \u2192 ${new Date(window.endAt).toISOString()}` : "\u2014";
  const lines = [
    `expectation: ${span} \u2014 ${expectation.liveBoxes} box(es) live, ${expectation.expectedBoxes} expected to settle (\u2265 ${(expectation.graceMs / 6e4).toFixed(0)} min live), ${expectation.settledBoxes} did`
  ];
  if (expectation.unsettledSandboxIds.length > 0) {
    lines.push(`       nothing settled against: ${expectation.unsettledSandboxIds.join(", ")}`);
  }
  return lines;
}
function measuredFields(finding) {
  const ms = (value) => value === null ? "\u2014" : `${(value / 36e5).toFixed(2)}h`;
  return [
    ["sandbox", finding.sandboxId ?? "\u2014"],
    ["workspace", finding.workspaceId ?? "\u2014"],
    ["amount", usd2(finding.settledNanoUsd)],
    ["settled", ms(finding.settledMs)],
    ["ceiling", ms(finding.ceilingMs)],
    ["overage", ms(finding.overageMs)],
    ["ceiling basis", finding.ceilingBasis ?? "\u2014"],
    ["duration basis", finding.durationBasis ?? "\u2014"],
    ["window", finding.windowStartAt === null ? "\u2014" : new Date(finding.windowStartAt).toISOString()],
    ["window end", finding.windowEndAt === null ? "\u2014" : new Date(finding.windowEndAt).toISOString()],
    ["window spend", usd2(finding.windowNanoUsd)],
    ["trailing median", usd2(finding.trailingMedianNanoUsd)],
    ["ratio", finding.velocityRatio === null ? "\u2014" : `${finding.velocityRatio.toFixed(1)}x`],
    ["balance", usd2(finding.balanceNanoUsd)],
    ["balance floor", usd2(finding.balanceFloorNanoUsd)],
    ["expected boxes", finding.expectedBoxes === null ? "\u2014" : String(finding.expectedBoxes)],
    ["settled boxes", finding.settledBoxes === null ? "\u2014" : String(finding.settledBoxes)],
    ["live in window", ms(finding.liveMsInWindow)]
  ];
}
function spendReportToJson(report) {
  return JSON.stringify(report, null, 2);
}

export {
  SPEND_CHECKS,
  ownedByBillingKeys,
  decideBoxOwnership,
  DEFAULT_CEILING_TOLERANCE_MS,
  computeExpectedCeiling,
  DEFAULT_EXPECTATION_GRACE_MS,
  assertSpendWindow,
  boxLivenessInWindow,
  assessAllExcluded,
  undeclaredExpectation,
  parseSettlementReference,
  parseSandboxGroupKey,
  settlementSandboxId,
  isCharge,
  chargeNanoUsd,
  reconcileSpend,
  formatSpendReport,
  spendReportToJson
};
//# sourceMappingURL=chunk-TRWJ5CRT.js.map