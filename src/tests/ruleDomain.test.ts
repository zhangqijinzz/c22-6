import { describe, expect, it } from 'vitest';
import { evaluateSample } from '../domain/conditionEvaluator';
import { validateField, validateProject } from '../domain/fieldValidation';
import { analyzeRules } from '../domain/ruleAnalysis';
import type { BusinessRule, RuleField, RuleProject } from '../models/ruleModel';

const amount: RuleField = { id: 'amount', name: '金额', type: 'number', min: 0, max: 1000 };
const tier: RuleField = { id: 'tier', name: '等级', type: 'enum', enumValues: ['basic', 'gold'] };
const active: RuleField = { id: 'active', name: '启用', type: 'boolean' };

function makeRule(id: string, conditions: BusinessRule['conditions'], priority = 10, result = id): BusinessRule {
  return { id, name: id, conditions, priority, result };
}

function project(rules: BusinessRule[], fields: RuleField[] = [amount, tier, active]): RuleProject {
  return { id: 'p', title: '测试项目', fields, rules, sampleInputs: {}, versions: [], updatedAt: 1 };
}

const amountAtLeast = (value: number): BusinessRule['conditions'] => ({ kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'gte', value }] });

describe('field and project validation', () => {
  it('accepts inclusive boundary ranges and rejects reversed or empty definitions', () => {
    expect(validateField({ ...amount, min: 5, max: 5 })).toEqual([]);
    expect(validateField({ ...amount, min: 11, max: 10 }).map((issue) => issue.code)).toContain('number-range-order');
    expect(validateField({ id: 'tier', name: '等级', type: 'enum', enumValues: [] }).map((issue) => issue.code)).toContain('enum-values-required');
  });

  it('checks enum and boolean predicate types without depending on React', () => {
    const rules = [
      makeRule('gold', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'tier', operator: 'eq', value: 'gold' }] }),
      makeRule('active', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'active', operator: 'isTrue', value: true }] }),
    ];
    expect(validateProject(project(rules))).toEqual([]);
    expect(evaluateSample(project(rules), { amount: 12, tier: 'gold', active: true }).matchedRules.map((rule) => rule.id)).toEqual(['gold', 'active']);
  });
});

describe('rule consistency analysis', () => {
  it('finds partial overlap, same-priority conflicts, lower-priority shadowing, unreachable rules, and gaps', () => {
    const rules = [
      makeRule('base', amountAtLeast(500), 10, 'standard'),
      makeRule('partial', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'between', value: { min: 300, max: 800 } }] }, 20, 'special'),
      makeRule('conflict', amountAtLeast(700), 20, 'different'),
      makeRule('hidden', amountAtLeast(750), 5, 'hidden'),
      makeRule('impossible', amountAtLeast(1001), 50, 'out of range'),
      makeRule('no-overlap', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'lt', value: 250 }] }, 1, 'separate'),
    ];
    const analysis = analyzeRules(project(rules));
    expect(analysis.overlaps.some((overlap) => overlap.ruleAId === 'partial' && overlap.ruleBId === 'conflict' && overlap.conflict)).toBe(true);
    expect(analysis.overlaps.some((overlap) => overlap.ruleAId === 'base' && overlap.ruleBId === 'no-overlap')).toBe(false);
    expect(analysis.unreachableRuleIds).toContain('impossible');
    expect(analysis.shadowedRuleIds).toContain('hidden');
    expect(analysis.uncoveredExamples.length).toBeGreaterThan(0);
    expect(analysis.checkedCases).toBeGreaterThan(0);
  });

  it('evaluates OR groups and validates missing sample inputs precisely', () => {
    const rule = makeRule('either', { kind: 'group', operator: 'or', conditions: [
      { kind: 'predicate', fieldId: 'tier', operator: 'eq', value: 'gold' },
      { kind: 'predicate', fieldId: 'active', operator: 'isTrue', value: true },
    ] });
    const result = evaluateSample(project([rule]), { amount: 10, tier: 'basic', active: true });
    expect(result.valid).toBe(true);
    expect(result.winner?.id).toBe('either');
    const missing = evaluateSample(project([rule]), { amount: 10, tier: 'gold' });
    expect(missing.errors).toEqual(['请填写“启用”']);
  });
});

describe('unreachable and shadowed explanations', () => {
  it('pinpoints out-of-domain conditions and offers a boundary probe that reproduces the dead end', () => {
    const rules = [makeRule('too-high', amountAtLeast(1001), 10)];
    const target = project(rules);
    const analysis = analyzeRules(target);
    expect(analysis.unreachableReasons).toHaveLength(1);
    const reason = analysis.unreachableReasons[0];
    expect(reason.cause?.blocker?.kind).toBe('out-of-domain');
    expect(reason.cause?.blocker?.fieldId).toBe('amount');
    expect(reason.probe?.amount).toBe(1000);
    const replay = evaluateSample(target, reason.probe ?? {});
    expect(replay.valid).toBe(true);
    expect(replay.matchedRules.some((rule) => rule.id === 'too-high')).toBe(false);
  });

  it('reports contradicting conditions on the same field within an and-chain', () => {
    const rules = [makeRule('contradiction', { kind: 'group', operator: 'and', conditions: [
      { kind: 'predicate', fieldId: 'amount', operator: 'gte', value: 800 },
      { kind: 'predicate', fieldId: 'amount', operator: 'lt', value: 500 },
    ] })];
    const analysis = analyzeRules(project(rules));
    const blocker = analysis.unreachableReasons[0].cause?.blocker;
    expect(blocker?.kind).toBe('contradiction');
    expect(blocker?.conditions.map((condition) => condition.operator)).toEqual(['gte', 'lt']);
  });

  it('explains enum conditions that exhaust every legal option', () => {
    const solo: RuleField = { id: 'solo', name: '唯一选项', type: 'enum', enumValues: ['only'] };
    const rules = [makeRule('enum-dead', { kind: 'group', operator: 'and', conditions: [
      { kind: 'predicate', fieldId: 'solo', operator: 'notEq', value: 'only' },
    ] })];
    const target = project(rules, [solo]);
    const analysis = analyzeRules(target);
    const reason = analysis.unreachableReasons[0];
    expect(reason.cause?.blocker?.kind).toBe('out-of-domain');
    const replay = evaluateSample(target, reason.probe ?? {});
    expect(replay.valid).toBe(true);
    expect(replay.matchedRules).toHaveLength(0);
  });

  it('breaks down or-groups where every branch is impossible', () => {
    const rules = [makeRule('or-dead', { kind: 'group', operator: 'or', conditions: [
      { kind: 'predicate', fieldId: 'amount', operator: 'gt', value: 1000 },
      { kind: 'predicate', fieldId: 'amount', operator: 'lt', value: 0 },
    ] })];
    const analysis = analyzeRules(project(rules));
    const cause = analysis.unreachableReasons[0].cause;
    expect(cause?.branches).toHaveLength(2);
    expect(cause?.branches?.every((branch) => branch.blocker?.kind === 'out-of-domain')).toBe(true);
  });

  it('names the earlier rule, the input segment, and a reproducible witness for shadowed rules', () => {
    const rules = [
      makeRule('early', amountAtLeast(500), 20, 'early'),
      makeRule('late', amountAtLeast(750), 10, 'late'),
    ];
    const target = project(rules);
    const analysis = analyzeRules(target);
    expect(analysis.shadowedReasons).toHaveLength(1);
    const reason = analysis.shadowedReasons[0];
    expect(reason.ruleId).toBe('late');
    expect(reason.matchedCases).toBeGreaterThan(0);
    const segment = reason.segments[0];
    expect(segment.winnerRuleId).toBe('early');
    expect(segment.matchedCases).toBe(reason.matchedCases);
    expect(segment.span.find((span) => span.fieldId === 'amount')).toMatchObject({ min: 750, max: 1000 });
    const replay = evaluateSample(target, segment.witness);
    expect(replay.winner?.id).toBe('early');
    expect(replay.matchedRules.map((rule) => rule.id)).toContain('late');
  });

  it('recomputes conclusions when field ranges or the rule set change', () => {
    const rules = [makeRule('too-high', amountAtLeast(1001), 10)];
    expect(analyzeRules(project(rules)).unreachableReasons).toHaveLength(1);
    const wider = analyzeRules(project(rules, [{ ...amount, max: 2000 }, tier, active]));
    expect(wider.unreachableRuleIds).toHaveLength(0);
    expect(wider.unreachableReasons).toHaveLength(0);
    const shadowRules = [makeRule('early', amountAtLeast(500), 20, 'early'), makeRule('late', amountAtLeast(750), 10, 'late')];
    expect(analyzeRules(project(shadowRules)).shadowedReasons.map((reason) => reason.ruleId)).toEqual(['late']);
    const withoutEarly = analyzeRules(project(shadowRules.filter((rule) => rule.id !== 'early')));
    expect(withoutEarly.shadowedReasons).toHaveLength(0);
  });
});
