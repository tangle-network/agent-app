// src/knowledge/index.ts
function clamp(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
function buildKnowledgeRequirements(specs, signals = {}) {
  return specs.map((spec) => {
    const signal = signals[spec.id];
    return {
      id: spec.id,
      description: spec.description,
      requiredFor: spec.requiredFor ?? [],
      category: spec.category,
      acquisitionMode: spec.acquisitionMode,
      importance: spec.importance ?? "blocking",
      freshness: spec.freshness ?? "static",
      sensitivity: spec.sensitivity ?? "private",
      confidenceNeeded: spec.confidenceNeeded ?? 1,
      currentConfidence: clamp(signal?.confidence ?? 0),
      evidenceIds: signal?.evidence ? [signal.evidence] : [],
      fallbackPolicy: spec.acquisitionMode === "ask_user" ? "ask" : "block"
    };
  });
}
async function deriveSignals(specs, ctx) {
  const out = {};
  for (const spec of specs) {
    if (spec.derive) {
      out[spec.id] = { confidence: clamp(await spec.derive(ctx)), evidence: spec.evidence };
    } else if (spec.satisfiedBy) {
      const ok = await evalRule(spec.satisfiedBy, ctx);
      out[spec.id] = ok ? { confidence: 1, evidence: spec.evidence ?? describeRule(spec.satisfiedBy) } : { confidence: 0 };
    } else {
      out[spec.id] = { confidence: 0 };
    }
  }
  return out;
}
async function evalRule(rule, ctx) {
  if ("anyOf" in rule) {
    for (const sub of rule.anyOf) if (await evalRule(sub, ctx)) return true;
    return false;
  }
  if ("allOf" in rule) {
    for (const sub of rule.allOf) if (!await evalRule(sub, ctx)) return false;
    return true;
  }
  if ("config" in rule) {
    const value = ctx.config(rule.config);
    if (rule.nonEmpty) return Array.isArray(value) ? value.length > 0 : value != null && value !== "";
    return value != null && value !== "" && value !== false;
  }
  const rows = await ctx.count({ table: rule.table, where: rule.where, statusIn: rule.statusIn });
  return rows >= (rule.minRows ?? 1);
}
function describeRule(rule) {
  if ("anyOf" in rule) return `anyOf(${rule.anyOf.map(describeRule).join(",")})`;
  if ("allOf" in rule) return `allOf(${rule.allOf.map(describeRule).join(",")})`;
  if ("config" in rule) return `config:${rule.config}`;
  return `${rule.table}${rule.statusIn ? `[${rule.statusIn.join("|")}]` : ""}>=${rule.minRows ?? 1}`;
}
export {
  buildKnowledgeRequirements,
  deriveSignals
};
//# sourceMappingURL=index.js.map