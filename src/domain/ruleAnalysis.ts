import type {
  BusinessRule,
  FieldSpan,
  MatchWitness,
  RuleAnalysis,
  RuleCondition,
  RuleField,
  RuleOverlap,
  RuleProject,
  SampleInput,
  ScalarValue,
  ShadowSegment,
  ShadowedReason,
  UnreachableReason,
} from '../models/ruleModel';
import { matchesRule } from './conditionEvaluator';
import { explainUnreachable } from './reachability';

const MAX_CASES = 120_000;
const MAX_EXAMPLES = 4;
const MAX_SPAN_VALUES = 16;

type SpanAccum =
  | { kind: 'number'; min: number; max: number }
  | { kind: 'set'; values: Set<ScalarValue> };

interface ShadowWinnerAccum {
  count: number;
  witness: SampleInput;
  spans: Map<string, SpanAccum>;
}

interface ShadowRuleAccum {
  matched: number;
  winners: Map<string, ShadowWinnerAccum>;
}

export function analyzeRules(project: RuleProject): RuleAnalysis {
  const candidates = project.fields.map((field) => valuesForField(field, project));
  const overlaps = new Map<string, RuleOverlap>();
  const seen = new Set<string>();
  const visible = new Set<string>();
  const processedMatchSets = new Set<string>();
  const uncoveredExamples: SampleInput[] = [];
  const shadowStats = new Map<string, ShadowRuleAccum>();
  const ordered = [...project.rules].sort((a, b) => b.priority - a.priority || project.rules.indexOf(a) - project.rules.indexOf(b));
  let checkedCases = 0;
  let coveredCases = 0;
  let truncated = false;

  const visit = (fieldIndex: number, values: SampleInput): void => {
    if (checkedCases >= MAX_CASES) {
      truncated = true;
      return;
    }
    if (fieldIndex < project.fields.length) {
      const field = project.fields[fieldIndex];
      for (const value of candidates[fieldIndex]) {
        values[field.id] = value;
        visit(fieldIndex + 1, values);
        if (truncated) break;
      }
      delete values[field.id];
      return;
    }
    checkedCases += 1;
    const matched = ordered.filter((rule) => matchesRule(rule, values));
    for (const rule of matched) seen.add(rule.id);
    if (matched.length) coveredCases += 1;
    else if (uncoveredExamples.length < MAX_EXAMPLES) uncoveredExamples.push({ ...values });
    if (matched[0]) {
      visible.add(matched[0].id);
      for (let index = 1; index < matched.length; index += 1) {
        recordShadow(shadowStats, matched[index], matched[0], values, project.fields);
      }
    }
    const matchSetKey = matched.length > 1 ? matched.map((rule) => rule.id).sort().join('|') : '';
    if (matched.length > 1 && !processedMatchSets.has(matchSetKey)) {
      processedMatchSets.add(matchSetKey);
      for (let left = 0; left < matched.length; left += 1) {
        for (let right = left + 1; right < matched.length; right += 1) {
          const ruleA = matched[left];
          const ruleB = matched[right];
          const key = [ruleA.id, ruleB.id].sort().join('|');
          if (!overlaps.has(key)) {
            overlaps.set(key, {
              ruleAId: ruleA.id,
              ruleBId: ruleB.id,
              conflict: ruleA.priority === ruleB.priority && ruleA.result !== ruleB.result,
              witness: { ...values },
            });
          }
        }
      }
    }
  };

  visit(0, {});
  const unreachableRuleIds = project.rules.filter((rule) => !seen.has(rule.id)).map((rule) => rule.id);
  const shadowedRuleIds = project.rules.filter((rule) => seen.has(rule.id) && !visible.has(rule.id)).map((rule) => rule.id);
  const unreachableReasons = buildUnreachableReasons(project, unreachableRuleIds);
  const shadowedReasons = buildShadowedReasons(project, shadowedRuleIds, shadowStats);

  return {
    checkedCases,
    coveredCases,
    coveragePercent: checkedCases ? Math.round((coveredCases / checkedCases) * 100) : 0,
    overlaps: [...overlaps.values()],
    unreachableRuleIds,
    shadowedRuleIds,
    unreachableReasons,
    shadowedReasons,
    uncoveredExamples,
    truncated,
  };
}

function buildUnreachableReasons(project: RuleProject, ruleIds: string[]): UnreachableReason[] {
  return ruleIds.map((ruleId) => {
    const rule = project.rules.find((candidate) => candidate.id === ruleId);
    const explanation = rule ? explainUnreachable(rule, project.fields) : {};
    return { ruleId, cause: explanation.cause, probe: explanation.probe };
  });
}

function buildShadowedReasons(
  project: RuleProject,
  ruleIds: string[],
  stats: Map<string, ShadowRuleAccum>,
): ShadowedReason[] {
  return ruleIds.map((ruleId) => {
    const entry = stats.get(ruleId);
    const segments: ShadowSegment[] = [...(entry?.winners.entries() ?? [])]
      .map(([winnerRuleId, accum]) => ({
        winnerRuleId,
        matchedCases: accum.count,
        span: project.fields
          .map((field) => toFieldSpan(field, accum.spans.get(field.id)))
          .filter((span): span is FieldSpan => span !== null),
        witness: accum.witness,
      }))
      .sort((a, b) => b.matchedCases - a.matchedCases);
    return { ruleId, matchedCases: entry?.matched ?? 0, segments };
  });
}

function recordShadow(
  stats: Map<string, ShadowRuleAccum>,
  rule: BusinessRule,
  winner: BusinessRule,
  values: SampleInput,
  fields: RuleField[],
): void {
  let entry = stats.get(rule.id);
  if (!entry) {
    entry = { matched: 0, winners: new Map() };
    stats.set(rule.id, entry);
  }
  entry.matched += 1;
  let accum = entry.winners.get(winner.id);
  if (!accum) {
    accum = { count: 0, witness: { ...values }, spans: new Map() };
    entry.winners.set(winner.id, accum);
  }
  accum.count += 1;
  for (const field of fields) {
    const value = values[field.id];
    if (value === undefined || value === '') continue;
    let span = accum.spans.get(field.id);
    if (!span) {
      span = field.type === 'number'
        ? { kind: 'number', min: Infinity, max: -Infinity }
        : { kind: 'set', values: new Set<ScalarValue>() };
      accum.spans.set(field.id, span);
    }
    if (span.kind === 'number' && typeof value === 'number') {
      span.min = Math.min(span.min, value);
      span.max = Math.max(span.max, value);
    } else if (span.kind === 'set' && span.values.size < MAX_SPAN_VALUES) {
      span.values.add(value);
    }
  }
}

function toFieldSpan(field: RuleField, span: SpanAccum | undefined): FieldSpan | null {
  if (!span) return null;
  if (span.kind === 'number') {
    const min = field.min ?? 0;
    const max = field.max ?? min;
    if (span.min <= min && span.max >= max) return null;
    return { fieldId: field.id, min: span.min, max: span.max };
  }
  const legalCount = field.type === 'boolean' ? 2 : (field.enumValues ?? []).length;
  if (span.values.size >= legalCount) return null;
  return { fieldId: field.id, values: [...span.values] };
}

type ScalarCandidate = string | number | boolean;

function valuesForField(field: RuleField, project: RuleProject): ScalarCandidate[] {
  if (field.type === 'boolean') return [false, true];
  if (field.type === 'enum') return field.enumValues ?? [];
  const min = field.min ?? 0;
  const max = field.max ?? min;
  const breaks = new Set<number>([min, max]);
  for (const rule of project.rules) collectBreaks(rule.conditions, field.id, min, max, breaks);
  const sorted = [...breaks].sort((a, b) => a - b);
  const values = new Set<number>(sorted);
  for (let index = 0; index < sorted.length - 1; index += 1) {
    values.add(sorted[index] + (sorted[index + 1] - sorted[index]) / 2);
  }
  return [...values].sort((a, b) => a - b);
}

function collectBreaks(
  condition: RuleCondition,
  fieldId: string,
  min: number,
  max: number,
  breaks: Set<number>,
): void {
  if (condition.kind === 'group') {
    condition.conditions.forEach((child) => collectBreaks(child, fieldId, min, max, breaks));
    return;
  }
  if (condition.fieldId !== fieldId) return;
  let boundaries: number[];
  if (typeof condition.value === 'number') boundaries = [condition.value];
  else if (typeof condition.value === 'object' && condition.value !== null && 'min' in condition.value && 'max' in condition.value) boundaries = [condition.value.min, condition.value.max];
  else return;
  for (const value of boundaries) if (value >= min && value <= max) breaks.add(value);
}

export const ruleAnalysisService = { analyze: analyzeRules };

export function firstOverlapWitness(analysis: RuleAnalysis): MatchWitness | undefined {
  const overlap = analysis.overlaps[0];
  return overlap ? { values: overlap.witness, ruleIds: [overlap.ruleAId, overlap.ruleBId] } : undefined;
}
