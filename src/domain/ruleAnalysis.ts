import type {
  MatchWitness,
  RuleAnalysis,
  RuleCondition,
  RuleField,
  RuleOverlap,
  RuleProject,
  SampleInput,
} from '../models/ruleModel';
import { matchesRule } from './conditionEvaluator';
import { explainRuleFindings } from './ruleFindings';

const MAX_CASES = 120_000;
const MAX_EXAMPLES = 4;

export function analyzeRules(project: RuleProject): RuleAnalysis {
  const candidates = project.fields.map((field) => valuesForField(field, project));
  const overlaps = new Map<string, RuleOverlap>();
  const seen = new Set<string>();
  const visible = new Set<string>();
  const processedMatchSets = new Set<string>();
  const uncoveredExamples: SampleInput[] = [];
  const shadowWitnesses = new Map<string, SampleInput>();
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
    for (const rule of matched) {
      seen.add(rule.id);
      if (rule.id !== matched[0]?.id && !shadowWitnesses.has(rule.id)) shadowWitnesses.set(rule.id, { ...values });
    }
    if (matched.length) coveredCases += 1;
    else if (uncoveredExamples.length < MAX_EXAMPLES) uncoveredExamples.push({ ...values });
    if (matched[0]) visible.add(matched[0].id);
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

  // 结论基于本次的字段范围与规则顺序现场算出；任何调整都会触发重算。
  const findings = explainRuleFindings(project, shadowWitnesses)
    .filter((finding) => finding.kind === 'unreachable'
      ? unreachableRuleIds.includes(finding.ruleId)
      : shadowedRuleIds.includes(finding.ruleId))
    .sort((a, b) => {
      const order = (id: string): number => project.rules.findIndex((rule) => rule.id === id);
      return order(a.ruleId) - order(b.ruleId);
    });

  return {
    checkedCases,
    coveredCases,
    coveragePercent: checkedCases ? Math.round((coveredCases / checkedCases) * 100) : 0,
    overlaps: [...overlaps.values()],
    unreachableRuleIds,
    shadowedRuleIds,
    findings,
    uncoveredExamples,
    truncated,
  };
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
