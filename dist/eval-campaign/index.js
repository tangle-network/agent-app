// src/eval-campaign/index.ts
import {
  aggregateJudgeVerdicts
} from "@tangle-network/agent-eval";

// src/eval-campaign/trust-gate.ts
import {
  interRaterReliability
} from "@tangle-network/agent-eval";
var DEFAULT_IRR_FLOOR = 0.2;
var DEFAULT_SPREAD_CEILING = 0.5;
var DEFAULT_MIN_SURVIVORS = 3;
function survivors(item) {
  return item.verdicts.filter((v) => v.perDimension !== null);
}
function itemSpread(survivorVerdicts) {
  if (survivorVerdicts.length < 2) return 0;
  const dims = /* @__PURE__ */ new Set();
  for (const v of survivorVerdicts) {
    for (const d of Object.keys(v.perDimension)) dims.add(d);
  }
  let worst = 0;
  for (const d of dims) {
    let min = Infinity;
    let max = -Infinity;
    for (const v of survivorVerdicts) {
      const score = v.perDimension[d];
      if (score === void 0) continue;
      if (score < min) min = score;
      if (score > max) max = score;
    }
    if (max > -Infinity && max - min > worst) worst = max - min;
  }
  return worst;
}
function trustVerdicts(items, thresholds = {}) {
  if (items.length === 0) {
    throw new Error("trustVerdicts: items is empty \u2014 no evidence to trust");
  }
  const irrFloor = thresholds.irrFloor ?? DEFAULT_IRR_FLOOR;
  const spreadCeiling = thresholds.spreadCeiling ?? DEFAULT_SPREAD_CEILING;
  const minSurvivors = thresholds.minSurvivors ?? DEFAULT_MIN_SURVIVORS;
  const maxRaters = items.reduce((m, it) => Math.max(m, survivors(it).length), 0);
  const raterSeries = Array.from({ length: maxRaters }, () => []);
  const perItemSpread = {};
  const splitItems = [];
  const starvedItems = [];
  for (const item of items) {
    const surv = survivors(item);
    if (surv.length < minSurvivors) starvedItems.push({ itemId: item.itemId, n: surv.length });
    const spread = itemSpread(surv);
    perItemSpread[item.itemId] = spread;
    if (spread > spreadCeiling) splitItems.push({ itemId: item.itemId, spread });
    if (surv.length >= 2) {
      const dims = Array.from(
        new Set(surv.flatMap((v) => Object.keys(v.perDimension)))
      ).sort();
      surv.forEach((v, raterIdx) => {
        const column = raterSeries[raterIdx] ??= [];
        const pd = v.perDimension;
        for (const d of dims) {
          const score = pd[d];
          if (score === void 0) continue;
          column.push({
            judgeName: v.model,
            dimension: `${item.itemId}::${d}`,
            score,
            reasoning: v.rationale ?? ""
          });
        }
      });
    }
  }
  const irr = interRaterReliability(raterSeries);
  const trustReasons = [];
  if (irr < irrFloor) {
    trustReasons.push(`(1) IRR ${round(irr)} < ${irrFloor}`);
  }
  for (const { itemId, spread } of splitItems) {
    trustReasons.push(`(2) item ${itemId} spread ${round(spread)} > ${spreadCeiling} \u2014 raters split`);
  }
  for (const { itemId, n } of starvedItems) {
    trustReasons.push(`(3) item ${itemId}: ${n} surviving raters < ${minSurvivors}`);
  }
  return {
    trustworthy: trustReasons.length === 0,
    trustReasons,
    interRaterReliability: irr,
    perItemSpread
  };
}
function round(n) {
  return Math.round(n * 100) / 100;
}

// src/eval-campaign/index.ts
import { aggregateJudgeVerdicts as aggregateJudgeVerdicts2 } from "@tangle-network/agent-eval";
import {
  compareOptimizationMethods,
  defaultProductionGate,
  externalTextOptimizationMethod,
  gepaOptimizationMethod,
  paretoSignificanceGate,
  runCampaign,
  skillOptOptimizationMethod
} from "@tangle-network/agent-eval/campaign";
import { selfImprove } from "@tangle-network/agent-eval/contract";
function buildEnsembleJudge(cfg) {
  const reps = cfg.judgeReps ?? 1;
  if (reps < 1) {
    throw new Error(`buildEnsembleJudge: judgeReps must be >= 1 (got ${reps})`);
  }
  if (cfg.rubric.length === 0) {
    throw new Error("buildEnsembleJudge: rubric is empty");
  }
  return {
    name: cfg.name,
    ...cfg.judgeVersion === void 0 ? {} : { judgeVersion: cfg.judgeVersion },
    dimensions: cfg.rubric.map((key) => ({ key, description: cfg.describe?.(key) ?? key })),
    async score(input) {
      const settled = await Promise.allSettled(
        Array.from({ length: reps }, (_, rep) => cfg.scoreOne({ ...input, rep }))
      );
      const verdicts = settled.map(
        (r, rep) => r.status === "fulfilled" ? r.value : { model: `${cfg.name}-rep${rep}`, perDimension: null, rationale: String(r.reason) }
      );
      const agg = aggregateJudgeVerdicts(verdicts, cfg.rubric, cfg.weights);
      return { composite: agg.composite, dimensions: agg.perDimension, notes: agg.rationale };
    }
  };
}
export {
  aggregateJudgeVerdicts2 as aggregateJudgeVerdicts,
  buildEnsembleJudge,
  compareOptimizationMethods,
  defaultProductionGate,
  externalTextOptimizationMethod,
  gepaOptimizationMethod,
  paretoSignificanceGate,
  runCampaign,
  selfImprove,
  skillOptOptimizationMethod,
  trustVerdicts
};
//# sourceMappingURL=index.js.map