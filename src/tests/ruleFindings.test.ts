import { describe, expect, it } from 'vitest';
import { analyzeRules } from '../domain/ruleAnalysis';
import { evaluateSample } from '../domain/conditionEvaluator';
import type { BlockedTerm, BusinessRule, RuleField, RuleProject, ShadowSegment } from '../models/ruleModel';

const amount: RuleField = { id: 'amount', name: '金额', type: 'number', min: 0, max: 1000 };
const tier: RuleField = { id: 'tier', name: '等级', type: 'enum', enumValues: ['basic', 'gold'] };
const active: RuleField = { id: 'active', name: '启用', type: 'boolean' };

function makeRule(id: string, conditions: BusinessRule['conditions'], priority = 10, result = id): BusinessRule {
  return { id, name: id, conditions, priority, result };
}
function makeProject(rules: BusinessRule[], fields: RuleField[] = [amount, tier, active]): RuleProject {
  return { id: 'p', title: '诊断项目', fields, rules, sampleInputs: {}, versions: [], updatedAt: 1 };
}

const atLeast = (fieldId: string, value: number): BusinessRule['conditions'] => ({
  kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId, operator: 'gte', value }],
});

describe('unreachable findings', () => {
  it('reports a numeric requirement that never meets the legal range and a replay input rejected by validation', () => {
    const project = makeProject([makeRule('too-high', atLeast('amount', 1001))]);
    const finding = analyzeRules(project).findings.find((item) => item.kind === 'unreachable' && item.ruleId === 'too-high');
    expect(finding?.kind).toBe('unreachable');
    if (finding?.kind !== 'unreachable') return;
    const term = finding.blockedTerms[0] as BlockedTerm;
    const cause = term.causes.find((item) => item.fieldId === 'amount');
    expect(cause?.kind).toBe('number-gap');
    if (cause?.kind !== 'number-gap') return;
    expect(cause.legal).toEqual({ kind: 'number', min: 0, max: 1000, minInclusive: true, maxInclusive: true });
    expect(cause.lower?.value).toBe(1001);
    expect(cause.lower?.from.text).toBe('金额大于等于1001');

    expect(finding.repro.values.amount).toBe(1001);
    expect(finding.repro.valid).toBe(false);
    expect(finding.repro.invalidFieldIds).toEqual(['amount']);
    const evaluation = evaluateSample(project, finding.repro.values);
    expect(evaluation.valid).toBe(false);
    expect(evaluation.errors.join('')).toContain('金额');
  });

  it('reports a contradictory in-range pair without an out-of-range replay value', () => {
    const project = makeProject([makeRule('squeeze', {
      kind: 'group', operator: 'and', conditions: [
        { kind: 'predicate', fieldId: 'amount', operator: 'gt', value: 800 },
        { kind: 'predicate', fieldId: 'amount', operator: 'lt', value: 800 },
      ],
    })]);
    const finding = analyzeRules(project).findings.find((item) => item.ruleId === 'squeeze');
    if (finding?.kind !== 'unreachable') throw new Error('expected unreachable finding');
    const cause = finding.blockedTerms[0].causes[0];
    expect(cause.kind).toBe('number-gap');
    if (cause.kind !== 'number-gap') return;
    expect(cause.lower?.inclusive).toBe(false);
    expect(cause.upper?.inclusive).toBe(false);
    expect(finding.repro.valid).toBe(true);
    expect(finding.repro.values.amount).toBe(800);
    const evaluation = evaluateSample(project, finding.repro.values);
    expect(evaluation.valid).toBe(true);
    expect(evaluation.matchedRules).toEqual([]);
  });

  it('reports enum and boolean predicates that conflict within the legal values', () => {
    const project = makeProject([
      makeRule('enum-conflict', { kind: 'group', operator: 'and', conditions: [
        { kind: 'predicate', fieldId: 'tier', operator: 'eq', value: 'gold' },
        { kind: 'predicate', fieldId: 'tier', operator: 'eq', value: 'basic' },
      ] }),
      makeRule('bool-conflict', { kind: 'group', operator: 'and', conditions: [
        { kind: 'predicate', fieldId: 'active', operator: 'isTrue', value: true },
        { kind: 'predicate', fieldId: 'active', operator: 'isFalse', value: false },
      ] }),
    ]);
    const findings = analyzeRules(project).findings;
    const enumFinding = findings.find((item) => item.ruleId === 'enum-conflict');
    const boolFinding = findings.find((item) => item.ruleId === 'bool-conflict');
    expect(enumFinding?.kind).toBe('unreachable');
    expect(boolFinding?.kind).toBe('unreachable');
    if (enumFinding?.kind !== 'unreachable' || boolFinding?.kind !== 'unreachable') return;
    expect(enumFinding.blockedTerms[0].causes[0].kind).toBe('conflict');
    expect(boolFinding.blockedTerms[0].causes[0].kind).toBe('conflict');
  });

  it('reports an out-of-range between interval with structured bounds', () => {
    const project = makeProject([makeRule('far-window', {
      kind: 'group', operator: 'and', conditions: [
        { kind: 'predicate', fieldId: 'amount', operator: 'between', value: { min: 1200, max: 2000 } },
      ],
    })]);
    const finding = analyzeRules(project).findings[0];
    if (finding?.kind !== 'unreachable') throw new Error('expected unreachable finding');
    const cause = finding.blockedTerms[0].causes[0];
    expect(cause.kind).toBe('number-gap');
    if (cause.kind !== 'number-gap') return;
    expect(cause.lower?.value).toBe(1200);
    expect(cause.upper?.value).toBe(2000);
    expect(finding.repro.values.amount).toBe(1200);
    expect(finding.repro.invalidFieldIds).toEqual(['amount']);
  });

  it('treats not-equal against the only enum option as impossible but still legal to replay', () => {
    const singleTier: RuleField = { id: 'tier', name: '等级', type: 'enum', enumValues: ['only'] };
    const project = makeProject([makeRule('not-only', {
      kind: 'group', operator: 'and', conditions: [
        { kind: 'predicate', fieldId: 'tier', operator: 'notEq', value: 'only' },
      ],
    })], [amount, singleTier, active]);
    const finding = analyzeRules(project).findings[0];
    if (finding?.kind !== 'unreachable') throw new Error('expected unreachable finding');
    const cause = finding.blockedTerms[0].causes[0];
    expect(cause.kind).toBe('enum-gap');
    expect(finding.repro.valid).toBe(true);
    expect(finding.repro.values.tier).toBe('only');
    const evaluation = evaluateSample(project, finding.repro.values);
    expect(evaluation.valid).toBe(true);
    expect(evaluation.matchedRules).toEqual([]);
  });

  it('lists each infeasible OR branch with its own cause', () => {
    const project = makeProject([makeRule('either-side', {
      kind: 'group', operator: 'or', conditions: [
        { kind: 'predicate', fieldId: 'amount', operator: 'gt', value: 5000 },
        { kind: 'predicate', fieldId: 'amount', operator: 'lt', value: -10 },
      ],
    })]);
    const finding = analyzeRules(project).findings[0];
    if (finding?.kind !== 'unreachable') throw new Error('expected unreachable finding');
    expect(finding.blockedTerms).toHaveLength(2);
    expect(finding.blockedTerms.map((term) => term.requirements[0].text)).toEqual(['金额大于5000', '金额小于-10']);
  });

  it('drops the conclusion as soon as the field range widens enough to reach the rule', () => {
    const rules = [makeRule('high', atLeast('amount', 900))];
    expect(analyzeRules(makeProject(rules)).findings).toHaveLength(0);
    const narrowed = makeProject(rules, [{ ...amount, max: 500 }, tier, active]);
    const analysis = analyzeRules(narrowed);
    expect(analysis.findings).toHaveLength(1);
    const finding = analysis.findings[0];
    if (finding.kind !== 'unreachable') throw new Error('expected unreachable finding');
    const cause = finding.blockedTerms[0].causes[0];
    expect(cause.kind).toBe('number-gap');
    if (cause.kind !== 'number-gap') return;
    expect(cause.legal.max).toBe(500);
  });
});

describe('shadowed findings', () => {
  it('splits the covered region by the actual first-matching earlier rule', () => {
    const project = makeProject([
      makeRule('base', atLeast('amount', 500), 10, 'standard'),
      makeRule('partial', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'between', value: { min: 300, max: 800 } }] }, 20, 'special'),
      makeRule('conflict', atLeast('amount', 700), 20, 'different'),
      makeRule('hidden', atLeast('amount', 750), 5, 'hidden'),
    ]);
    const findings = analyzeRules(project).findings;
    const baseFinding = findings.find((item) => item.ruleId === 'base');
    const hiddenFinding = findings.find((item) => item.ruleId === 'hidden');
    expect(baseFinding?.kind).toBe('shadowed');
    expect(hiddenFinding?.kind).toBe('shadowed');
    if (baseFinding?.kind !== 'shadowed' || hiddenFinding?.kind !== 'shadowed') return;

    const eaterOf = (segments: ShadowSegment[], min: number): string | undefined =>
      segments.find((segment) => {
        const domain = segment.range.amount;
        return domain?.kind === 'number' && domain.min === min;
      })?.byRuleId;
    expect(eaterOf(baseFinding.segments, 500)).toBe('partial');
    expect(eaterOf(baseFinding.segments, 800)).toBe('conflict');
    expect(eaterOf(hiddenFinding.segments, 750)).toBe('partial');
    expect(eaterOf(hiddenFinding.segments, 800)).toBe('conflict');

    for (const finding of [baseFinding, hiddenFinding]) {
      for (const segment of finding.segments) {
        const evaluation = evaluateSample(project, segment.witness);
        expect(evaluation.winner?.id).toBe(segment.byRuleId);
      }
      const replay = evaluateSample(project, finding.repro.values);
      expect(replay.matchedRules.map((rule) => rule.id)).toContain(finding.ruleId);
      expect(replay.winner?.id).not.toBe(finding.ruleId);
    }
  });

  it('keeps the eater extra field constraints in every segment and its witness', () => {
    const project = makeProject([
      makeRule('wide', atLeast('amount', 100), 10, 'wide'),
      makeRule('gold-only', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'tier', operator: 'eq', value: 'gold' }] }, 20, 'gold'),
      makeRule('basic-only', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'tier', operator: 'eq', value: 'basic' }] }, 20, 'basic'),
    ]);
    const finding = analyzeRules(project).findings.find((item) => item.ruleId === 'wide');
    if (finding?.kind !== 'shadowed') throw new Error('expected shadowed finding');
    const byEater = Object.fromEntries(finding.segments.map((segment) => [segment.byRuleId, segment]));
    expect(byEater['gold-only'].range.tier).toEqual({ kind: 'enum', values: ['gold'] });
    expect(byEater['basic-only'].range.tier).toEqual({ kind: 'enum', values: ['basic'] });
    expect(byEater['gold-only'].witness.tier).toBe('gold');
    expect(byEater['basic-only'].witness.tier).toBe('basic');
  });

  it('produces no finding when the rule still owns some legal input', () => {
    const project = makeProject([
      makeRule('low', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'lt', value: 100 }] }, 10, 'low'),
      makeRule('high', atLeast('amount', 500), 20, 'high'),
    ]);
    expect(analyzeRules(project).findings).toHaveLength(0);
  });
});
