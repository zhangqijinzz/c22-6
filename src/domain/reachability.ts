import type {
  BusinessRule,
  PredicateCondition,
  RuleCondition,
  RuleField,
  SampleInput,
  ScalarValue,
  UnreachableCause,
} from '../models/ruleModel';

interface NumberInterval {
  min: number;
  max: number;
  minExclusive: boolean;
  maxExclusive: boolean;
}

type FieldDomain =
  | { kind: 'number'; intervals: NumberInterval[] }
  | { kind: 'enum'; values: string[] }
  | { kind: 'boolean'; values: boolean[] };

interface Blockage {
  cause: UnreachableCause;
  domains: Map<string, FieldDomain>;
  blockedFieldId?: string;
  blockedCondition?: PredicateCondition;
}

interface WalkState {
  domains: Map<string, FieldDomain>;
  applied: Map<string, PredicateCondition[]>;
}

export interface UnreachableExplanation {
  cause?: UnreachableCause;
  probe?: SampleInput;
}

/**
 * 按当前字段的合法取值域现场推导规则不可达的原因。
 * 沿 AND 链逐条收缩每个字段的可行域，第一个把可行域掏空的条件就是卡点；
 * OR 组只有在所有分支都不可满足时才成为卡点。同时构造一个最接近满足条件的
 * 合法输入（探针），可直接送进样例推演复现“条件不成立”。
 */
export function explainUnreachable(rule: BusinessRule, fields: RuleField[]): UnreachableExplanation {
  const fieldById = new Map(fields.map((field) => [field.id, field]));
  const state: WalkState = {
    domains: new Map(fields.map((field) => [field.id, legalDomain(field)])),
    applied: new Map(),
  };
  const blockage = walkAnd([rule.conditions], state, fieldById);
  if (!blockage) return {};
  return { cause: blockage.cause, probe: buildProbe(fields, blockage) };
}

function walkAnd(conditions: RuleCondition[], state: WalkState, fields: Map<string, RuleField>): Blockage | null {
  for (const condition of conditions) {
    if (condition.kind === 'group') {
      const blockage = condition.operator === 'and'
        ? walkAnd(condition.conditions, state, fields)
        : applyOr(condition.conditions, state, fields);
      if (blockage) return blockage;
    } else {
      const blockage = applyPredicate(condition, state, fields);
      if (blockage) return blockage;
    }
  }
  return null;
}

function applyOr(branches: RuleCondition[], state: WalkState, fields: Map<string, RuleField>): Blockage | null {
  if (!branches.length) return null;
  const successes: Map<string, FieldDomain>[] = [];
  const blockages: Blockage[] = [];
  for (const branch of branches) {
    const branchState: WalkState = {
      domains: new Map([...state.domains].map(([id, domain]) => [id, cloneDomain(domain)])),
      applied: new Map([...state.applied].map(([id, list]) => [id, [...list]])),
    };
    const blockage = walkAnd([branch], branchState, fields);
    if (blockage) blockages.push(blockage);
    else successes.push(branchState.domains);
  }
  if (!successes.length) {
    const first = blockages[0];
    return { ...first, cause: { branches: blockages.map((item) => item.cause) } };
  }
  for (const fieldId of state.domains.keys()) {
    let merged = successes[0].get(fieldId) as FieldDomain;
    for (let index = 1; index < successes.length; index += 1) {
      merged = unionDomains(merged, successes[index].get(fieldId) as FieldDomain);
    }
    state.domains.set(fieldId, merged);
  }
  return null;
}

function applyPredicate(condition: PredicateCondition, state: WalkState, fields: Map<string, RuleField>): Blockage | null {
  const field = fields.get(condition.fieldId);
  if (!field) return null;
  const current = state.domains.get(field.id) ?? legalDomain(field);
  const accepted = predicateDomain(field, condition);
  const next = intersectDomains(current, accepted);
  if (!isEmpty(next)) {
    state.domains.set(field.id, next);
    const list = state.applied.get(field.id) ?? [];
    list.push(condition);
    state.applied.set(field.id, list);
    return null;
  }
  const outOfDomain = isEmpty(intersectDomains(legalDomain(field), accepted));
  const prior = state.applied.get(field.id) ?? [];
  return {
    cause: {
      blocker: {
        kind: outOfDomain ? 'out-of-domain' : 'contradiction',
        fieldId: field.id,
        conditions: [...prior, condition],
      },
    },
    domains: state.domains,
    blockedFieldId: field.id,
    blockedCondition: condition,
  };
}

function legalDomain(field: RuleField): FieldDomain {
  if (field.type === 'number') {
    const min = field.min ?? 0;
    return { kind: 'number', intervals: [{ min, max: field.max ?? min, minExclusive: false, maxExclusive: false }] };
  }
  if (field.type === 'enum') return { kind: 'enum', values: [...(field.enumValues ?? [])] };
  return { kind: 'boolean', values: [false, true] };
}

function predicateDomain(field: RuleField, condition: PredicateCondition): FieldDomain {
  if (field.type === 'number') {
    const interval = numberInterval(condition);
    return { kind: 'number', intervals: interval ? [interval] : [] };
  }
  if (field.type === 'enum') {
    const legal = field.enumValues ?? [];
    const value = typeof condition.value === 'string' ? condition.value : '';
    return { kind: 'enum', values: condition.operator === 'notEq' ? legal.filter((item) => item !== value) : [value] };
  }
  return { kind: 'boolean', values: [condition.operator === 'isFalse' ? false : true] };
}

function numberInterval(condition: PredicateCondition): NumberInterval | null {
  const value = condition.value;
  if (typeof value === 'number') {
    switch (condition.operator) {
      case 'eq': return { min: value, max: value, minExclusive: false, maxExclusive: false };
      case 'gt': return { min: value, max: Infinity, minExclusive: true, maxExclusive: false };
      case 'gte': return { min: value, max: Infinity, minExclusive: false, maxExclusive: false };
      case 'lt': return { min: -Infinity, max: value, minExclusive: false, maxExclusive: true };
      case 'lte': return { min: -Infinity, max: value, minExclusive: false, maxExclusive: false };
      default: return null;
    }
  }
  if (typeof value === 'object' && value !== null && 'min' in value && 'max' in value) {
    return { min: value.min, max: value.max, minExclusive: false, maxExclusive: false };
  }
  return null;
}

function intersectDomains(current: FieldDomain, next: FieldDomain): FieldDomain {
  if (current.kind === 'number' && next.kind === 'number') {
    const intervals: NumberInterval[] = [];
    for (const a of current.intervals) {
      for (const b of next.intervals) {
        const merged = intersectInterval(a, b);
        if (merged) intervals.push(merged);
      }
    }
    return { kind: 'number', intervals };
  }
  if (current.kind === 'enum' && next.kind === 'enum') {
    return { kind: 'enum', values: current.values.filter((value) => next.values.includes(value)) };
  }
  if (current.kind === 'boolean' && next.kind === 'boolean') {
    return { kind: 'boolean', values: current.values.filter((value) => next.values.includes(value)) };
  }
  return current;
}

function intersectInterval(a: NumberInterval, b: NumberInterval): NumberInterval | null {
  const min = Math.max(a.min, b.min);
  const max = Math.min(a.max, b.max);
  const minExclusive = a.min > b.min ? a.minExclusive : b.min > a.min ? b.minExclusive : a.minExclusive || b.minExclusive;
  const maxExclusive = a.max < b.max ? a.maxExclusive : b.max < a.max ? b.maxExclusive : a.maxExclusive || b.maxExclusive;
  if (min > max) return null;
  if (min === max && (minExclusive || maxExclusive)) return null;
  return { min, max, minExclusive, maxExclusive };
}

function unionDomains(a: FieldDomain, b: FieldDomain): FieldDomain {
  if (a.kind === 'number' && b.kind === 'number') return { kind: 'number', intervals: [...a.intervals, ...b.intervals] };
  if (a.kind === 'enum' && b.kind === 'enum') return { kind: 'enum', values: [...new Set([...a.values, ...b.values])] };
  if (a.kind === 'boolean' && b.kind === 'boolean') return { kind: 'boolean', values: [...new Set([...a.values, ...b.values])] };
  return a;
}

function cloneDomain(domain: FieldDomain): FieldDomain {
  if (domain.kind === 'number') return { kind: 'number', intervals: [...domain.intervals] };
  if (domain.kind === 'enum') return { kind: 'enum', values: [...domain.values] };
  return { kind: 'boolean', values: [...domain.values] };
}

function isEmpty(domain: FieldDomain): boolean {
  return domain.kind === 'number' ? domain.intervals.length === 0 : domain.values.length === 0;
}

function buildProbe(fields: RuleField[], blockage: Blockage): SampleInput {
  const probe: SampleInput = {};
  for (const field of fields) {
    const domain = blockage.domains.get(field.id) ?? legalDomain(field);
    const value = field.id === blockage.blockedFieldId && blockage.blockedCondition
      ? nearestValue(domain, blockage.blockedCondition)
      : pickValue(domain);
    probe[field.id] = value ?? defaultValue(field);
  }
  return probe;
}

function nearestValue(domain: FieldDomain, condition: PredicateCondition): ScalarValue | undefined {
  if (domain.kind !== 'number') return pickValue(domain);
  const target = numberInterval(condition);
  if (!target || !domain.intervals.length) return pickNumber(domain.intervals);
  const currentMin = Math.min(...domain.intervals.map((interval) => interval.min));
  const currentMax = Math.max(...domain.intervals.map((interval) => interval.max));
  if (target.min >= currentMax) return currentMax;
  if (target.max <= currentMin) return currentMin;
  return pickNumber(domain.intervals);
}

function pickValue(domain: FieldDomain): ScalarValue | undefined {
  if (domain.kind === 'number') return pickNumber(domain.intervals);
  return domain.values[0];
}

function pickNumber(intervals: NumberInterval[]): number | undefined {
  const first = intervals[0];
  if (!first) return undefined;
  if (first.min === first.max) return first.min;
  if (Number.isFinite(first.min) && Number.isFinite(first.max)) return first.min + (first.max - first.min) / 2;
  if (Number.isFinite(first.min)) return first.minExclusive ? first.min + 1 : first.min;
  if (Number.isFinite(first.max)) return first.maxExclusive ? first.max - 1 : first.max;
  return 0;
}

function defaultValue(field: RuleField): ScalarValue {
  if (field.type === 'number') return field.min ?? 0;
  if (field.type === 'enum') return field.enumValues?.[0] ?? '';
  return false;
}
