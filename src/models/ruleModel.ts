export type FieldType = 'number' | 'enum' | 'boolean';
export type ScalarValue = string | number | boolean;
export type ModuleId = 'fields' | 'rules' | 'samples' | 'inspection';

export interface RuleField {
  id: string;
  name: string;
  type: FieldType;
  enumValues?: string[];
  min?: number;
  max?: number;
}

export interface NumberRange {
  min: number;
  max: number;
}

export type PredicateCondition =
  | { kind: 'predicate'; fieldId: string; operator: 'eq' | 'gt' | 'gte' | 'lt' | 'lte'; value: number }
  | { kind: 'predicate'; fieldId: string; operator: 'between'; value: NumberRange }
  | { kind: 'predicate'; fieldId: string; operator: 'eq' | 'notEq'; value: string }
  | { kind: 'predicate'; fieldId: string; operator: 'isTrue' | 'isFalse'; value: boolean };

export interface ConditionGroup {
  kind: 'group';
  operator: 'and' | 'or';
  conditions: RuleCondition[];
}

export type RuleCondition = PredicateCondition | ConditionGroup;

export interface BusinessRule {
  id: string;
  name: string;
  conditions: ConditionGroup;
  priority: number;
  result: string;
}

export type SampleInput = Record<string, ScalarValue | ''>;

export interface RuleVersion {
  id: string;
  name: string;
  savedAt: number;
  frozen: boolean;
  fields: RuleField[];
  rules: BusinessRule[];
  sampleInputs: SampleInput;
}

export interface RuleProject {
  id: string;
  title: string;
  fields: RuleField[];
  rules: BusinessRule[];
  sampleInputs: SampleInput;
  versions: RuleVersion[];
  frozenVersionId?: string;
  updatedAt: number;
}

export interface WorkspaceDocument {
  schemaVersion: 1;
  projects: RuleProject[];
  activeProjectId: string;
}

export interface ValidationIssue {
  code: string;
  message: string;
  fieldId?: string;
  ruleId?: string;
}

export interface MatchWitness {
  values: SampleInput;
  ruleIds: string[];
}

/** 某个字段在当前合法取值范围内的一段范围（用于现场计算出的原因说明）。 */
export type FieldDomainSnapshot =
  | { kind: 'number'; min: number; max: number; minInclusive: boolean; maxInclusive: boolean }
  | { kind: 'enum'; values: string[] }
  | { kind: 'boolean'; values: boolean[] };

/** 条件里对某字段提出的单个取值要求，保留原文以便界面逐字核对。 */
export interface RequirementEvidence {
  fieldId: string;
  operator: PredicateCondition['operator'];
  value: ScalarValue;
  /** operator 为 between 时携带结构化区间，其余情况为空。 */
  range?: { min: number; max: number };
  text: string;
}

/** 一个分支（AND 项）走不通的现场原因。 */
export type TermCause =
  | {
    kind: 'number-gap';
    fieldId: string;
    requirements: RequirementEvidence[];
    legal: Extract<FieldDomainSnapshot, { kind: 'number' }>;
    lower: { value: number; inclusive: boolean; from: RequirementEvidence } | null;
    upper: { value: number; inclusive: boolean; from: RequirementEvidence } | null;
  }
  | {
    kind: 'enum-gap';
    fieldId: string;
    requirement: RequirementEvidence;
    legalValues: string[];
  }
  | {
    kind: 'conflict';
    fieldId: string;
    fieldType: FieldType;
    requirements: RequirementEvidence[];
    legalDomain: FieldDomainSnapshot;
  };

/** OR 规则中一个永远不成立的 AND 分支。 */
export interface BlockedTerm {
  /** 该分支包含的全部条件原文。 */
  requirements: RequirementEvidence[];
  causes: TermCause[];
}

/** 可以直接送进样例推演的输入与预期复现结果。 */
export interface ReproductionInput {
  values: SampleInput;
  valid: boolean;
  invalidFieldIds: string[];
  expected: string;
}

/** 遮蔽关系中的一段输入范围。 */
export interface ShadowSegment {
  range: Record<string, FieldDomainSnapshot>;
  byRuleId: string;
  witness: SampleInput;
}

export type RuleFinding =
  | {
    kind: 'unreachable';
    ruleId: string;
    blockedTerms: BlockedTerm[];
    repro: ReproductionInput;
  }
  | {
    kind: 'shadowed';
    ruleId: string;
    segments: ShadowSegment[];
    truncated: boolean;
    repro: ReproductionInput;
  };

export interface RuleOverlap {
  ruleAId: string;
  ruleBId: string;
  conflict: boolean;
  witness: SampleInput;
}

export interface RuleAnalysis {
  checkedCases: number;
  coveredCases: number;
  coveragePercent: number;
  overlaps: RuleOverlap[];
  unreachableRuleIds: string[];
  shadowedRuleIds: string[];
  /** 针对当前字段范围与规则集合现场算出的、带证据的诊断结论。 */
  findings: RuleFinding[];
  uncoveredExamples: SampleInput[];
  truncated: boolean;
}

export interface SampleEvaluation {
  valid: boolean;
  errors: string[];
  matchedRules: BusinessRule[];
  winner?: BusinessRule;
}

export interface DomainChecker {
  analyze(project: RuleProject): RuleAnalysis;
  validateProject(project: RuleProject): ValidationIssue[];
}

export const fieldLabel = (field: RuleField): string => field.name || '未命名字段';
