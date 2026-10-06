import type {
  BlockedTerm,
  BusinessRule,
  FieldDomainSnapshot,
  PredicateCondition,
  RequirementEvidence,
  ReproductionInput,
  RuleCondition,
  RuleField,
  RuleFinding,
  RuleProject,
  SampleInput,
  ScalarValue,
  ShadowSegment,
  TermCause,
} from '../models/ruleModel';

const MAX_TERMS = 2000;
const MAX_BLOCKED_TERMS = 8;
const MAX_SEGMENTS_PER_RULE = 60;
const MAX_PIECES = 4000;

type NumberDomain = { kind: 'number'; lo: number; hi: number; loInc: boolean; hiInc: boolean };
type EnumDomain = { kind: 'enum'; values: Set<string> };
type BooleanDomain = { kind: 'boolean'; values: Set<boolean> };
type Domain = NumberDomain | EnumDomain | BooleanDomain;

type Box = Map<string, Domain>;
type Term = PredicateCondition[];

interface FieldTrace {
  field: RuleField;
  requirements: RequirementEvidence[];
}

/**
 * 针对“当前”字段范围与规则顺序，现场计算每条不可达 / 被遮蔽规则的可核对原因。
 * 输入空间用盒域（数值区间 / 枚举子集 / 布尔子集）精确表示；
 * project 一变，结论随 analyzeRules 一起重算，不会沿用上一轮判断。
 */
export function explainRuleFindings(
  project: RuleProject,
  fallbackWitness: Map<string, SampleInput>,
): RuleFinding[] {
  const fields = project.fields;
  const base = baseDomains(fields);

  const truthByRule = new Map<string, Box[]>();
  const termCapHit = new Set<string>();
  for (const rule of project.rules) {
    const terms = toDnf(rule.conditions);
    if (terms.length >= MAX_TERMS) termCapHit.add(rule.id);
    const feasible: Box[] = [];
    for (const term of terms.slice(0, MAX_TERMS)) {
      const evaluated = termToBox(term, fields, base);
      if (!evaluated || !evaluated.feasible || containsBox(feasible, evaluated.box)) continue;
      feasible.push(evaluated.box);
    }
    truthByRule.set(rule.id, feasible);
  }

  const findings: Array<RuleFinding | null> = [];
  for (const rule of project.rules) {
    const truth = truthByRule.get(rule.id) ?? [];
    if (truth.length === 0 && !termCapHit.has(rule.id)) {
      findings.push(unreachableFinding(rule, fields, base, fallbackWitness.get(rule.id)));
      continue;
    }
    if (truth.length === 0) continue;
    findings.push(shadowFinding(rule, truth, project, fields, base, truthByRule, termCapHit.has(rule.id), fallbackWitness.get(rule.id)));
  }
  return findings.filter((finding): finding is RuleFinding => finding !== null);
}

function shadowFinding(
  rule: BusinessRule,
  truth: Box[],
  project: RuleProject,
  fields: RuleField[],
  base: Map<string, Domain>,
  truthByRule: Map<string, Box[]>,
  termCapReached: boolean,
  fallback?: SampleInput,
): RuleFinding | null {
  // 严格模拟首条命中决胜：按优先级（同优先级按列表顺序）逐条扫描更早规则，
  // 每个残片里被“当前这条”覆盖的部分就归它吃掉，其余残片继续往后找。
  const earlier = priorityOrder(project).filter((candidate) => candidate.id !== rule.id && earlierThan(candidate, rule, project));
  let remaining: Box[] = truth;
  const segments: ShadowSegment[] = [];
  let truncated = termCapReached;

  for (const other of earlier) {
    if (!remaining.length) break;
    const otherTruth = truthByRule.get(other.id) ?? [];
    const stillRemaining: Box[] = [];
    for (const piece of remaining) {
      let uncovered: Box[] = [piece];
      const covered: Box[] = [];
      for (const cover of otherTruth) {
        const nextUncovered: Box[] = [];
        for (const current of uncovered) {
          const hit = intersectBoxes(current, cover);
          if (hit) covered.push(hit);
          nextUncovered.push(...subtractBoxes(current, cover));
        }
        uncovered = mergeBoxes(nextUncovered);
        if (segments.length + covered.length + uncovered.length + stillRemaining.length > MAX_PIECES) {
          truncated = true;
          break;
        }
      }
      for (const coveredPiece of covered) {
        if (segments.length >= MAX_SEGMENTS_PER_RULE) {
          truncated = true;
          continue;
        }
        segments.push({
          range: snapshotRestricted(coveredPiece, base),
          byRuleId: other.id,
          witness: witnessFromBox(coveredPiece, fields, base),
        });
      }
      stillRemaining.push(...uncovered);
      if (truncated) break;
    }
    remaining = mergeBoxes(stillRemaining);
    if (truncated) break;
  }

  if (remaining.length > 0) return null;

  const deduped = dedupeSegments(segments);
  const firstWitness = deduped[0]?.witness ?? fallback ?? witnessFromBox(truth[0], fields, base);
  return {
    kind: 'shadowed',
    ruleId: rule.id,
    segments: deduped,
    truncated,
    repro: {
      values: { ...firstWitness },
      valid: true,
      invalidFieldIds: [],
      expected: shadowExpected(rule, deduped[0]?.byRuleId, project),
    },
  };
}

// ---- 字段合法范围 ----

function baseDomains(fields: RuleField[]): Map<string, Domain> {
  const domains = new Map<string, Domain>();
  for (const field of fields) {
    if (field.type === 'number') {
      const min = field.min ?? 0;
      const max = field.max ?? min;
      domains.set(field.id, { kind: 'number', lo: min, hi: max, loInc: true, hiInc: true });
    } else if (field.type === 'enum') {
      domains.set(field.id, { kind: 'enum', values: new Set(field.enumValues ?? []) });
    } else {
      domains.set(field.id, { kind: 'boolean', values: new Set([false, true]) });
    }
  }
  return domains;
}

// ---- 条件转 DNF：OR 展平为 AND 分支列表 ----

function toDnf(group: BusinessRule['conditions']): Term[] {
  const terms = collectTerms(group);
  return terms.length ? terms.slice(0, MAX_TERMS) : [[]];
}

function collectTerms(condition: RuleCondition): Term[] {
  if (condition.kind === 'predicate') return [[condition]];
  const childTerms = condition.conditions.length ? condition.conditions.map((child) => collectTerms(child)) : [[]];
  if (condition.operator === 'and') {
    return childTerms.reduce(
      (combined, terms) => combined.flatMap((sofar) => terms.map((term) => [...sofar, ...term])),
      [[]] as Term[],
    );
  }
  return childTerms.flat();
}

// ---- AND 分支与字段合法范围求交，并保留每个字段的条件轨迹 ----

interface TermEvaluation {
  box: Box;
  feasible: boolean;
  traces: Map<string, FieldTrace>;
}

function termToBox(term: Term, fields: RuleField[], base: Map<string, Domain>): TermEvaluation | null {
  const traces = new Map<string, FieldTrace>();
  for (const predicate of term) {
    const field = fields.find((candidate) => candidate.id === predicate.fieldId);
    if (!field) return null;
    const trace = traces.get(field.id) ?? { field, requirements: [] };
    trace.requirements.push(requirementEvidence(field, predicate));
    traces.set(field.id, trace);
  }
  // 盒域对所有字段稠密存储：未被条件约束的字段显式取合法全值域，
  // 这样与带额外字段约束的规则做减法时才不会漏切维度。
  const box: Box = new Map();
  for (const [fieldId, domain] of base) box.set(fieldId, cloneDomain(domain));
  let feasible = true;
  for (const fieldId of traces.keys()) {
    let current = cloneDomain(base.get(fieldId) as Domain);
    for (const predicate of term.filter((item) => item.fieldId === fieldId)) {
      current = applyPredicate(current, predicate);
    }
    if (isEmptyDomain(current)) feasible = false;
    box.set(fieldId, current);
  }
  return { box, feasible, traces };
}

function applyPredicate(domain: Domain, predicate: PredicateCondition): Domain {
  if (domain.kind === 'number') return applyNumber(domain, predicate);
  if (domain.kind === 'enum') return applyEnum(domain, predicate);
  return applyBoolean(domain, predicate);
}

function applyNumber(domain: NumberDomain, predicate: PredicateCondition): NumberDomain {
  const next: NumberDomain = { ...domain };
  const tightenLower = (value: number, inclusive: boolean): void => {
    if (value > next.lo || (value === next.lo && !inclusive && next.loInc)) {
      next.lo = value;
      next.loInc = inclusive;
    }
  };
  const tightenUpper = (value: number, inclusive: boolean): void => {
    if (value < next.hi || (value === next.hi && !inclusive && next.hiInc)) {
      next.hi = value;
      next.hiInc = inclusive;
    }
  };
  if (typeof predicate.value === 'number') {
    switch (predicate.operator) {
      case 'gt': tightenLower(predicate.value, false); break;
      case 'gte': tightenLower(predicate.value, true); break;
      case 'lt': tightenUpper(predicate.value, false); break;
      case 'lte': tightenUpper(predicate.value, true); break;
      case 'eq': tightenLower(predicate.value, true); tightenUpper(predicate.value, true); break;
      default: break;
    }
  } else if (predicate.operator === 'between' && typeof predicate.value === 'object') {
    tightenLower(predicate.value.min, true);
    tightenUpper(predicate.value.max, true);
  }
  return next;
}

function applyEnum(domain: EnumDomain, predicate: PredicateCondition): EnumDomain {
  if (typeof predicate.value !== 'string') return { ...domain, values: new Set<string>() };
  if (predicate.operator === 'eq') {
    return { ...domain, values: new Set(domain.values.has(predicate.value) ? [predicate.value] : []) };
  }
  return { ...domain, values: new Set([...domain.values].filter((value) => value !== predicate.value)) };
}

function applyBoolean(domain: BooleanDomain, predicate: PredicateCondition): BooleanDomain {
  const target = predicate.operator === 'isTrue';
  const values = new Set<boolean>();
  if (domain.values.has(target)) values.add(target);
  return { ...domain, values };
}

// ---- 不可达原因 ----

function unreachableFinding(rule: BusinessRule, fields: RuleField[], base: Map<string, Domain>, fallback?: SampleInput): RuleFinding {
  const terms = toDnf(rule.conditions);
  const blockedTerms: BlockedTerm[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    const result = termToBox(term, fields, base);
    if (!result || result.feasible) continue;
    const requirements = term.map((predicate) => {
      const field = fields.find((candidate) => candidate.id === predicate.fieldId);
      return requirementEvidence(field as RuleField, predicate);
    });
    const causes = infeasibleCauses(result, base);
    const key = JSON.stringify([requirements.map((item) => item.text), causes.map((cause) => JSON.stringify(cause))]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (blockedTerms.length < MAX_BLOCKED_TERMS) blockedTerms.push({ requirements, causes });
  }
  return {
    kind: 'unreachable',
    ruleId: rule.id,
    blockedTerms,
    repro: unreachableRepro(blockedTerms, fields, base, fallback),
  };
}

function infeasibleCauses(result: TermEvaluation, base: Map<string, Domain>): TermCause[] {
  const causes: TermCause[] = [];
  for (const [fieldId, trace] of result.traces) {
    const domain = result.box.get(fieldId) as Domain;
    if (!isEmptyDomain(domain)) continue;
    const legal = base.get(fieldId) as Domain;
    if (trace.field.type === 'number') causes.push(numberCause(fieldId, trace, legal as NumberDomain));
    else if (trace.field.type === 'enum') causes.push(enumCause(fieldId, trace, legal as EnumDomain));
    else causes.push({ kind: 'conflict', fieldId, fieldType: 'boolean', requirements: trace.requirements, legalDomain: snapshotDomain(legal) });
  }
  return causes;
}

interface Bound {
  value: number;
  inclusive: boolean;
  from: RequirementEvidence;
}

function numberBounds(trace: FieldTrace): { lower: Bound | null; upper: Bound | null } {
  let lower: Bound | null = null;
  let upper: Bound | null = null;
  trace.requirements.forEach((requirement) => {
    const considerLower = (value: number, inclusive: boolean): void => {
      if (!lower || value > lower.value || (value === lower.value && !inclusive && lower.inclusive)) {
        lower = { value, inclusive, from: requirement };
      }
    };
    const considerUpper = (value: number, inclusive: boolean): void => {
      if (!upper || value < upper.value || (value === upper.value && !inclusive && upper.inclusive)) {
        upper = { value, inclusive, from: requirement };
      }
    };
    if (typeof requirement.value === 'number') {
      switch (requirement.operator) {
        case 'gt': considerLower(requirement.value, false); break;
        case 'gte': considerLower(requirement.value, true); break;
        case 'lt': considerUpper(requirement.value, false); break;
        case 'lte': considerUpper(requirement.value, true); break;
        case 'eq': considerLower(requirement.value, true); considerUpper(requirement.value, true); break;
        default: break;
      }
    } else if (requirement.operator === 'between' && requirement.range) {
      considerLower(requirement.range.min, true);
      considerUpper(requirement.range.max, true);
    }
  });
  return { lower, upper };
}

function numberCause(fieldId: string, trace: FieldTrace, legal: NumberDomain): TermCause {
  const { lower, upper } = numberBounds(trace);
  return {
    kind: 'number-gap',
    fieldId,
    requirements: trace.requirements,
    legal: snapshotNumber(legal),
    lower: lower ? { value: lower.value, inclusive: lower.inclusive, from: lower.from } : null,
    upper: upper ? { value: upper.value, inclusive: upper.inclusive, from: upper.from } : null,
  };
}

function enumCause(fieldId: string, trace: FieldTrace, legal: EnumDomain): TermCause {
  const last = trace.requirements[trace.requirements.length - 1];
  // 最后一个要求本身落在合法选项里却仍走不通，说明是同字段条件互相打架，而不是取值表缺选项。
  if (last.operator === 'eq' && legal.values.has(String(last.value))) {
    return { kind: 'conflict', fieldId, fieldType: 'enum', requirements: trace.requirements, legalDomain: snapshotDomain(legal) };
  }
  return { kind: 'enum-gap', fieldId, requirement: last, legalValues: [...legal.values] };
}

// ---- 复现输入 ----

function unreachableRepro(blockedTerms: BlockedTerm[], fields: RuleField[], base: Map<string, Domain>, fallback?: SampleInput): ReproductionInput {
  const values = legalDefaults(fields, base);
  const invalidFieldIds: string[] = [];
  const cause = blockedTerms[0]?.causes[0];

  if (cause?.kind === 'number-gap') {
    const outOfRange = outOfRangeNumber(cause);
    if (outOfRange !== null) {
      values[cause.fieldId] = outOfRange;
      invalidFieldIds.push(cause.fieldId);
    } else {
      const witnessValue = contradictionWitnessNumber(cause);
      if (witnessValue !== null) values[cause.fieldId] = witnessValue;
    }
  } else if (cause?.kind === 'enum-gap') {
    if (cause.requirement.operator === 'notEq') {
      // 唯一选项还要“不等于”它：取这个合法值推演，规则依旧不命中。
      values[cause.fieldId] = cause.requirement.value as string;
    } else {
      values[cause.fieldId] = cause.requirement.value as string;
      invalidFieldIds.push(cause.fieldId);
    }
  }

  if (fallback && !invalidFieldIds.length) {
    for (const field of fields) {
      const value = fallback[field.id];
      if (value !== undefined && value !== '') values[field.id] = value;
    }
  }

  return {
    values,
    valid: invalidFieldIds.length === 0,
    invalidFieldIds,
    expected: invalidFieldIds.length
      ? '样例推演会先报该字段超出合法范围；改回合法值后本规则条件就不成立，因此永远无法命中。'
      : '在全部合法取值下推演，本规则都不会出现在命中列表中。',
  };
}

/** 要求整体落在合法范围之外：给一个越界值让样例校验直接拦住。 */
function outOfRangeNumber(cause: Extract<TermCause, { kind: 'number-gap' }>): number | null {
  const { legal, lower, upper } = cause;
  if (lower && lower.value > legal.max) return lower.value;
  if (lower && lower.value === legal.max && !lower.inclusive && legal.maxInclusive) return stepAbove(legal.max);
  if (upper && upper.value < legal.min) return upper.value;
  if (upper && upper.value === legal.min && !upper.inclusive && legal.minInclusive) return stepBelow(legal.min);
  return null;
}

/** 要求在合法范围内互相矛盾：取一个合法值（落在间隙边界），推演时规则仍不命中。 */
function contradictionWitnessNumber(cause: Extract<TermCause, { kind: 'number-gap' }>): number | null {
  const { legal, lower, upper } = cause;
  if (lower && upper && lower.value >= upper.value) {
    return clampNumber(lower.value, legal);
  }
  if (lower) return clampNumber(lower.value, legal);
  if (upper) return clampNumber(upper.value, legal);
  return null;
}

function clampNumber(value: number, legal: Extract<FieldDomainSnapshot, { kind: 'number' }>): number {
  return Math.min(legal.max, Math.max(legal.min, value));
}

function stepAbove(value: number): number {
  return Number.isInteger(value) ? value + 1 : value + (Number((value * 0.01).toPrecision(1)) || 0.01);
}

function stepBelow(value: number): number {
  return Number.isInteger(value) ? value - 1 : value - (Number((value * 0.01).toPrecision(1)) || 0.01);
}

function legalDefaults(fields: RuleField[], base: Map<string, Domain>): SampleInput {
  return Object.fromEntries(fields.map((field) => [field.id, representative(base.get(field.id) as Domain)])) as SampleInput;
}

function shadowExpected(rule: BusinessRule, byRuleId: string | undefined, project: RuleProject): string {
  const other = project.rules.find((candidate) => candidate.id === byRuleId);
  return `本组输入同时命中「${rule.name}」与更早的「${other?.name ?? byRuleId}」，推演显示最终结果取自后者，本规则被遮蔽。`;
}

// ---- 盒域运算 ----

function cloneDomain(domain: Domain): Domain {
  if (domain.kind === 'number') return { ...domain };
  if (domain.kind === 'enum') return { ...domain, values: new Set(domain.values) };
  return { ...domain, values: new Set(domain.values) };
}

function isEmptyDomain(domain: Domain): boolean {
  if (domain.kind === 'number') {
    if (domain.lo > domain.hi) return true;
    return domain.lo === domain.hi && (!domain.loInc || !domain.hiInc);
  }
  return domain.values.size === 0;
}

function intersectDomains(a: Domain, b: Domain): Domain | null {
  if (a.kind === 'number' && b.kind === 'number') {
    let lo = a.lo;
    let hi = a.hi;
    let loInc = a.loInc;
    let hiInc = a.hiInc;
    if (b.lo > lo || (b.lo === lo && !b.loInc)) { lo = b.lo; loInc = b.loInc; }
    if (b.hi < hi || (b.hi === hi && !b.hiInc)) { hi = b.hi; hiInc = b.hiInc; }
    const next: NumberDomain = { kind: 'number', lo, hi, loInc, hiInc };
    return isEmptyDomain(next) ? null : next;
  }
  if (a.kind === 'enum' && b.kind === 'enum') {
    const values = new Set([...a.values].filter((value) => b.values.has(value)));
    return values.size ? { kind: 'enum', values } : null;
  }
  if (a.kind === 'boolean' && b.kind === 'boolean') {
    const values = new Set([...a.values].filter((value) => b.values.has(value)));
    return values.size ? { kind: 'boolean', values } : null;
  }
  return null;
}

function intersectBoxes(a: Box, b: Box): Box | null {
  const result: Box = new Map();
  for (const fieldId of new Set([...a.keys(), ...b.keys()])) {
    const domainA = a.get(fieldId);
    const domainB = b.get(fieldId);
    // 只在一边出现的字段表示另一边对它无约束，直接保留约束侧即可。
    const intersection = domainA && domainB ? intersectDomains(domainA, domainB) : (domainA ?? domainB);
    if (!intersection) return null;
    result.set(fieldId, intersection);
  }
  return result;
}

/** 返回 a − b 的不相交盒域分片；b 必须与 a 相交。 */
function subtractBoxes(a: Box, b: Box): Box[] {
  const intersection = intersectBoxes(a, b);
  if (!intersection) return [a];
  if (boxEquals(a, intersection)) return [];
  return sliceOut(a, b);
}

function sliceOut(a: Box, b: Box): Box[] {
  const pieces: Box[] = [];
  const working: Box = new Map(a);
  for (const [fieldId, domainA] of a) {
    const domainB = b.get(fieldId);
    if (!domainB) continue;
    for (const outside of outsideParts(domainA, domainB)) {
      const piece: Box = new Map(working);
      piece.set(fieldId, outside);
      pieces.push(piece);
    }
    const kept = intersectDomains(domainA, domainB);
    if (!kept) return pieces;
    working.set(fieldId, kept);
  }
  return pieces;
}

function outsideParts(domainA: Domain, domainB: Domain): Domain[] {
  if (domainA.kind === 'number' && domainB.kind === 'number') {
    const parts: NumberDomain[] = [];
    if (domainB.lo > domainA.lo || (domainB.lo === domainA.lo && !domainB.loInc && domainA.loInc)) {
      parts.push({ kind: 'number', lo: domainA.lo, hi: domainB.lo, loInc: domainA.loInc, hiInc: !domainB.loInc });
    }
    if (domainB.hi < domainA.hi || (domainB.hi === domainA.hi && !domainB.hiInc && domainA.hiInc)) {
      parts.push({ kind: 'number', lo: domainB.hi, hi: domainA.hi, loInc: !domainB.hiInc, hiInc: domainA.hiInc });
    }
    return parts.filter((part) => !isEmptyDomain(part));
  }
  if (domainA.kind === 'enum' && domainB.kind === 'enum') {
    const values = new Set([...domainA.values].filter((value) => !domainB.values.has(value)));
    return values.size ? [{ kind: 'enum', values }] : [];
  }
  if (domainA.kind === 'boolean' && domainB.kind === 'boolean') {
    const values = new Set([...domainA.values].filter((value) => !domainB.values.has(value)));
    return values.size ? [{ kind: 'boolean', values }] : [];
  }
  return [];
}

function boxEquals(a: Box, b: Box): boolean {
  if (a.size !== b.size) return false;
  for (const [fieldId, domain] of a) {
    const other = b.get(fieldId);
    if (!other || !domainEquals(domain, other)) return false;
  }
  return true;
}

function domainEquals(a: Domain, b: Domain): boolean {
  if (a.kind === 'number' || b.kind === 'number') {
    if (a.kind !== 'number' || b.kind !== 'number') return false;
    return a.lo === b.lo && a.hi === b.hi && a.loInc === b.loInc && a.hiInc === b.hiInc;
  }
  return a.values.size === b.values.size && [...a.values].every((value) => b.values.has(value as never));
}

function containsBox(boxes: Box[], candidate: Box): boolean {
  return boxes.some((box) => boxEquals(box, candidate));
}

function mergeBoxes(boxes: Box[]): Box[] {
  return boxes.filter((box, index) => boxes.findIndex((other) => boxEquals(other, box)) === index);
}

// ---- 快照与见证 ----

function snapshotRestricted(box: Box, base: Map<string, Domain>): Record<string, FieldDomainSnapshot> {
  const range: Record<string, FieldDomainSnapshot> = {};
  for (const [fieldId, domain] of base) {
    const actual = box.get(fieldId) ?? domain;
    if (!domainEquals(actual, domain)) range[fieldId] = snapshotDomain(actual);
  }
  return range;
}

function snapshotDomain(domain: Domain): FieldDomainSnapshot {
  if (domain.kind === 'number') return snapshotNumber(domain);
  if (domain.kind === 'enum') return { kind: 'enum', values: [...domain.values] };
  return { kind: 'boolean', values: [...domain.values] };
}

function snapshotNumber(domain: NumberDomain): Extract<FieldDomainSnapshot, { kind: 'number' }> {
  return { kind: 'number', min: domain.lo, max: domain.hi, minInclusive: domain.loInc, maxInclusive: domain.hiInc };
}

function representative(domain: Domain): ScalarValue {
  if (domain.kind === 'number') {
    if (domain.loInc) return domain.lo;
    if (Number.isInteger(domain.lo) && domain.lo + 1 <= domain.hi) return domain.lo + 1;
    return domain.lo;
  }
  if (domain.kind === 'enum') return [...domain.values][0] ?? '';
  return [...domain.values][0] ?? false;
}

function witnessFromBox(box: Box, fields: RuleField[], base: Map<string, Domain>): SampleInput {
  const witness = legalDefaults(fields, base);
  for (const field of fields) {
    const domain = box.get(field.id);
    if (domain) witness[field.id] = representative(domain);
  }
  return witness;
}

function dedupeSegments(segments: ShadowSegment[]): ShadowSegment[] {
  const seen = new Set<string>();
  return segments.filter((segment) => {
    const key = JSON.stringify({ by: segment.byRuleId, range: segment.range });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---- 其他辅助 ----

function priorityOrder(project: RuleProject): BusinessRule[] {
  return [...project.rules].sort((a, b) => b.priority - a.priority || project.rules.indexOf(a) - project.rules.indexOf(b));
}

function earlierThan(candidate: BusinessRule, rule: BusinessRule, project: RuleProject): boolean {
  if (candidate.id === rule.id) return false;
  if (candidate.priority !== rule.priority) return candidate.priority > rule.priority;
  return project.rules.indexOf(candidate) < project.rules.indexOf(rule);
}

function requirementEvidence(field: RuleField, predicate: PredicateCondition): RequirementEvidence {
  const operatorLabel: Record<PredicateCondition['operator'], string> = {
    eq: '等于', gt: '大于', gte: '大于等于', lt: '小于', lte: '小于等于', between: '介于', notEq: '不等于', isTrue: '为真', isFalse: '为假',
  };
  const raw = predicate.value;
  const range = typeof raw === 'object' && raw !== null && 'min' in raw ? { min: raw.min, max: raw.max } : undefined;
  const isBoolean = predicate.operator === 'isTrue' || predicate.operator === 'isFalse';
  const target = range
    ? `${range.min} 到 ${range.max}`
    : isBoolean
      ? ''
      : formatScalar(raw as ScalarValue);
  const value: ScalarValue = range ? `${range.min}~${range.max}` : (raw as ScalarValue);
  return { fieldId: field.id, operator: predicate.operator, value, range, text: `${field.name}${operatorLabel[predicate.operator]}${target}` };
}

function formatScalar(value: ScalarValue): string {
  return typeof value === 'boolean' ? value ? '是' : '否' : String(value);
}
