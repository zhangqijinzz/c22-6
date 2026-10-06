import type {
  BusinessRule,
  ConditionBlocker,
  FieldSpan,
  NumberRange,
  PredicateCondition,
  RuleAnalysis,
  RuleProject,
  RuleVersion,
  SampleInput,
  ShadowedReason,
  UnreachableCause,
  UnreachableReason,
} from '../../models/ruleModel';
import type { WorkspaceState } from '../../viewmodels/workspaceViewModel';
import type { InspectionViewModel } from './inspectionViewModel';

const MAX_SHOWN_SEGMENTS = 3;

interface InspectionViewProps { state: WorkspaceState; viewModel: InspectionViewModel; onOpenRule: (ruleId: string) => void }

export function InspectionView({ state, viewModel, onOpenRule }: InspectionViewProps) {
  const project = state.project;
  const analysis = state.analysis;
  const isChecking = state.checkStatus === 'checking' || state.checkStatus === 'scheduled';
  const rules = project?.rules ?? [];
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  return (
    <section className="module-page inspection-page">
      <div className="page-heading">
        <div><span className="eyebrow">模块 04 / 完整性验证</span><h1>检查与版本</h1><p>定位冲突、遮蔽与遗漏，再保存或冻结一个可追溯版本。</p></div>
        <div className="button-row">{isChecking ? <button className="button button-quiet" onClick={() => viewModel.cancel()}>取消检查</button> : <button className="button button-primary" disabled={!rules.length || state.validationIssues.length > 0} onClick={() => void viewModel.check()}><span>⌕</span> 运行一致性检查</button>}</div>
      </div>

      {state.validationIssues.length > 0 && <div className="validation-banner"><strong>规则暂时无法检查</strong><span>{state.validationIssues[0].message}</span><button className="text-button" onClick={() => state.validationIssues[0].ruleId ? onOpenRule(state.validationIssues[0].ruleId) : undefined}>{state.validationIssues[0].ruleId ? '打开相关规则 →' : '修复项目定义'}</button></div>}
      {state.checkStatus === 'error' && !state.validationIssues.length && <div className="error-banner">检查失败：{state.notice}</div>}
      {!analysis && !state.validationIssues.length && <div className="loading-analysis card-surface"><div className={isChecking ? 'spinner' : 'analysis-orb'}>{isChecking ? '' : '✳'}</div><div><strong>{isChecking ? '正在分析条件空间' : '准备检查规则集合'}</strong><p>{isChecking ? '计算在独立工作线程中运行，可随时取消。' : '点击“运行一致性检查”查看覆盖与规则关系。'}</p></div>{state.checkStatus === 'success' && <span className="success-mark">✓</span>}</div>}
      {analysis && project && <AnalysisPanel analysis={analysis} project={project} byId={byId} onOpenRule={onOpenRule} onReplay={(values) => viewModel.replaySample(values)} />}

      <section className="versions-section">
        <div className="versions-heading"><div><span className="eyebrow">CHANGE HISTORY</span><h2>规则版本</h2><p>保存检查前后的结构快照。冻结后，当前规则只能通过复制版本继续修改。</p></div><div className="button-row"><button className="button button-subtle" disabled={!rules.length} onClick={() => viewModel.saveVersion()}>＋ 保存版本</button><button className="button button-outline" disabled={!rules.length || Boolean(project?.frozenVersionId)} onClick={() => viewModel.freeze()}>◈ 冻结当前</button></div></div>
        {project?.versions.length ? <div className="version-list">{project.versions.map((version, index) => <VersionRow key={version.id} version={version} index={index} current={project.frozenVersionId === version.id} onContinue={() => viewModel.continueFrom(version.id)} onCopy={() => viewModel.copyToProject(version.id)} />)}</div> : <div className="version-empty card-surface"><span>◷</span><p>还没有保存版本。规则结构和检查结果确认后，可以创建第一个快照。</p></div>}
      </section>
    </section>
  );
}

interface AnalysisPanelProps {
  analysis: RuleAnalysis;
  project: RuleProject;
  byId: Map<string, BusinessRule>;
  onOpenRule: (ruleId: string) => void;
  onReplay: (values: SampleInput) => void;
}

function AnalysisPanel({ analysis, project, byId, onOpenRule, onReplay }: AnalysisPanelProps) {
  const conflictCount = analysis.overlaps.filter((overlap) => overlap.conflict).length;
  const overlapCount = analysis.overlaps.length;
  const coveredRules = Math.max(0, project.rules.length - analysis.unreachableRuleIds.length);
  return <>
    <div className="analysis-summary">
      <MetricCard label="输入空间覆盖" value={`${analysis.coveragePercent}%`} detail={`${analysis.coveredCases} / ${analysis.checkedCases} 个代表分区`} icon="◌" tone={analysis.uncoveredExamples.length ? 'amber' : 'green'} />
      <MetricCard label="规则关系" value={`${overlapCount}`} detail={`${conflictCount} 个同优先级结果冲突`} icon="⇄" tone={conflictCount ? 'red' : 'blue'} />
      <MetricCard label="可命中规则" value={`${coveredRules} / ${project.rules.length}`} detail={`${analysis.unreachableRuleIds.length} 条不可达 · ${analysis.shadowedRuleIds.length} 条被遮蔽`} icon="⌁" tone={analysis.unreachableRuleIds.length ? 'amber' : 'green'} />
    </div>
    {analysis.truncated && <div className="truncated-banner">输入空间超过单次检查上限，以下数据来自已分析分区；请减少字段组合后再次检查。</div>}
    <div className="analysis-grid">
      <section className="analysis-card card-surface"><header className="analysis-card-heading"><span className="analysis-icon conflict-icon">⇄</span><div><h2>重叠与冲突</h2><p>同一输入命中多条规则；同优先级且结果不同会产生冲突。</p></div><b>{overlapCount}</b></header>
        {overlapCount ? <div className="finding-list">{analysis.overlaps.slice(0, 6).map((overlap) => <div className="finding-row" key={`${overlap.ruleAId}-${overlap.ruleBId}`}><div className="finding-copy"><div><button className="inline-rule-link" onClick={() => onOpenRule(overlap.ruleAId)}>{byId.get(overlap.ruleAId)?.name ?? overlap.ruleAId}</button><span className="finding-join">↔</span><button className="inline-rule-link" onClick={() => onOpenRule(overlap.ruleBId)}>{byId.get(overlap.ruleBId)?.name ?? overlap.ruleBId}</button></div><span>{formatWitness(overlap.witness, project)}</span></div><span className={overlap.conflict ? 'severity-tag severity-danger' : 'severity-tag severity-warn'}>{overlap.conflict ? '结果冲突' : '条件重叠'}</span></div>)}</div> : <SuccessEmpty text="没有发现规则重叠" />}
      </section>
      <section className="analysis-card card-surface"><header className="analysis-card-heading"><span className="analysis-icon coverage-icon">◔</span><div><h2>未覆盖输入</h2><p>没有任何规则命中的合法输入组合。</p></div><b>{analysis.uncoveredExamples.length ? '有' : '无'}</b></header>
        {analysis.uncoveredExamples.length ? <div className="finding-list">{analysis.uncoveredExamples.map((example, index) => <div className="uncovered-row" key={index}><span className="uncovered-index">0{index + 1}</span><div><strong>未命中输入组合</strong><span>{formatWitness(example, project)}</span></div><button className="text-button" onClick={() => onReplay(example)}>推演 ↗</button><span className="severity-tag severity-warn">未覆盖</span></div>)}</div> : <SuccessEmpty text="输入空间已完整覆盖" />}
      </section>
      <section className="analysis-card card-surface"><header className="analysis-card-heading"><span className="analysis-icon unreachable-icon">⊘</span><div><h2>不可达规则</h2><p>在字段合法取值范围内，条件组合从未成立。</p></div><b>{analysis.unreachableRuleIds.length}</b></header>
        {analysis.unreachableReasons.length ? <div className="reason-list">{analysis.unreachableReasons.map((reason) => <UnreachableFinding key={reason.ruleId} reason={reason} project={project} byId={byId} truncated={analysis.truncated} onOpenRule={onOpenRule} onReplay={onReplay} />)}</div> : <SuccessEmpty text="所有规则都存在可命中输入" />}
      </section>
      <section className="analysis-card card-surface"><header className="analysis-card-heading"><span className="analysis-icon hidden-icon">◉</span><div><h2>被完全遮蔽</h2><p>存在命中输入，但优先级路径上总有更早规则先命中。</p></div><b>{analysis.shadowedRuleIds.length}</b></header>
        {analysis.shadowedReasons.length ? <div className="reason-list">{analysis.shadowedReasons.map((reason) => <ShadowedFinding key={reason.ruleId} reason={reason} project={project} byId={byId} onOpenRule={onOpenRule} onReplay={onReplay} />)}</div> : <SuccessEmpty text="没有被完全遮蔽的规则" />}
      </section>
    </div>
  </>;
}

interface UnreachableFindingProps {
  reason: UnreachableReason;
  project: RuleProject;
  byId: Map<string, BusinessRule>;
  truncated: boolean;
  onOpenRule: (ruleId: string) => void;
  onReplay: (values: SampleInput) => void;
}

function UnreachableFinding({ reason, project, byId, truncated, onOpenRule, onReplay }: UnreachableFindingProps) {
  const probe = reason.probe;
  return <div className="reason-row">
    <div className="reason-head">
      <strong>{byId.get(reason.ruleId)?.name ?? reason.ruleId}</strong>
      <span className="reason-actions">
        {probe && <button className="text-button" onClick={() => onReplay(probe)}>验证边界输入 ↗</button>}
        <button className="text-button" onClick={() => onOpenRule(reason.ruleId)}>编辑条件 →</button>
      </span>
    </div>
    {reason.cause
      ? <CauseDetail cause={reason.cause} project={project} />
      : <p className="reason-line">在已分析的代表分区内没有命中{truncated ? '；输入空间过大被截断，建议缩小字段范围后复查' : ''}。</p>}
    {probe && <span className="reason-witness">最接近的合法输入：{formatWitness(probe, project)}</span>}
  </div>;
}

function CauseDetail({ cause, project }: { cause: UnreachableCause; project: RuleProject }) {
  if (cause.blocker) return <p className="reason-line">{formatBlocker(cause.blocker, project)}</p>;
  if (cause.branches?.length) {
    return <div className="reason-branches">
      <p className="reason-line">“或”组的每个分支都无法成立：</p>
      {cause.branches.map((branch, index) => <CauseDetail key={index} cause={branch} project={project} />)}
    </div>;
  }
  return null;
}

interface ShadowedFindingProps {
  reason: ShadowedReason;
  project: RuleProject;
  byId: Map<string, BusinessRule>;
  onOpenRule: (ruleId: string) => void;
  onReplay: (values: SampleInput) => void;
}

function ShadowedFinding({ reason, project, byId, onOpenRule, onReplay }: ShadowedFindingProps) {
  const shown = reason.segments.slice(0, MAX_SHOWN_SEGMENTS);
  const rest = reason.segments.length - shown.length;
  return <div className="reason-row">
    <div className="reason-head">
      <strong>{byId.get(reason.ruleId)?.name ?? reason.ruleId}</strong>
      <span className="reason-actions"><button className="text-button" onClick={() => onOpenRule(reason.ruleId)}>调整优先级 →</button></span>
    </div>
    <p className="reason-line">命中 {reason.matchedCases} 个代表分区，全部被更早的规则抢走：</p>
    {shown.map((segment) => {
      const winner = byId.get(segment.winnerRuleId);
      const spanText = formatSpan(segment.span, project);
      return <div className="segment-block" key={segment.winnerRuleId}>
        <div className="segment-row">
          <span className="reason-line">↳ 被「{winner?.name ?? segment.winnerRuleId}」(P{winner?.priority ?? '?'}) 覆盖 {segment.matchedCases} 区{spanText ? `：${spanText}` : '（全部命中输入）'}</span>
          <button className="text-button" onClick={() => onReplay(segment.witness)}>复现 ↗</button>
        </div>
        <span className="reason-witness">见证输入：{formatWitness(segment.witness, project)}</span>
      </div>;
    })}
    {rest > 0 && <p className="reason-line">另有 {rest} 条规则覆盖了剩余分区。</p>}
  </div>;
}

function MetricCard({ label, value, detail, icon, tone }: { label: string; value: string; detail: string; icon: string; tone: string }) {
  return <article className={`metric-card card-surface metric-${tone}`}><span className="metric-icon">{icon}</span><span className="metric-label">{label}</span><strong>{value}</strong><span className="metric-detail">{detail}</span></article>;
}

function SuccessEmpty({ text }: { text: string }) { return <div className="success-empty"><span>✓</span>{text}</div>; }

function formatWitness(values: SampleInput, project: RuleProject): string {
  return project.fields.map((field) => {
    const value = values[field.id];
    return `${field.name} ${typeof value === 'boolean' ? value ? '是' : '否' : value ?? '—'}`;
  }).join(' · ');
}

function formatBlocker(blocker: ConditionBlocker, project: RuleProject): string {
  const field = project.fields.find((item) => item.id === blocker.fieldId);
  const name = field?.name ?? blocker.fieldId;
  const conditions = blocker.conditions.map((condition) => `「${formatCondition(condition, project)}」`).join(' 与 ');
  if (blocker.kind === 'out-of-domain') {
    const legal = field?.type === 'number'
      ? `合法范围 ${field.min}–${field.max}`
      : `合法取值（${field?.type === 'boolean' ? '是 / 否' : (field?.enumValues ?? []).join(' / ')}）`;
    return `条件${conditions}超出“${name}”的${legal}，任何输入都无法成立`;
  }
  return `${conditions}在字段“${name}”上交集为空，无法同时成立`;
}

function formatCondition(condition: PredicateCondition, project: RuleProject): string {
  const field = project.fields.find((item) => item.id === condition.fieldId);
  const name = field?.name ?? condition.fieldId;
  const value = condition.value;
  switch (condition.operator) {
    case 'between': {
      const range = value as NumberRange;
      return `${name} 在 ${range.min}–${range.max} 之间`;
    }
    case 'eq': return `${name} = ${value}`;
    case 'notEq': return `${name} ≠ ${value}`;
    case 'gt': return `${name} > ${value}`;
    case 'gte': return `${name} ≥ ${value}`;
    case 'lt': return `${name} < ${value}`;
    case 'lte': return `${name} ≤ ${value}`;
    case 'isTrue': return `${name} 为“是”`;
    case 'isFalse': return `${name} 为“否”`;
    default: return name;
  }
}

function formatSpan(spans: FieldSpan[], project: RuleProject): string {
  return spans.map((span) => {
    const field = project.fields.find((item) => item.id === span.fieldId);
    const name = field?.name ?? span.fieldId;
    if (span.min !== undefined && span.max !== undefined) return `${name} ${span.min}–${span.max}`;
    const values = (span.values ?? []).map((value) => typeof value === 'boolean' ? value ? '是' : '否' : String(value));
    return values.length === 1 ? `${name} = ${values[0]}` : `${name} 为 ${values.join(' / ')}`;
  }).join(' · ');
}

function VersionRow({ version, index, current, onContinue, onCopy }: { version: RuleVersion; index: number; current: boolean; onContinue: () => void; onCopy: () => void }) {
  return <article className={`version-row${current ? ' version-current' : ''}`}><span className="version-number">{String(index + 1).padStart(2, '0')}</span><div className="version-copy"><strong>{version.name}{current && <em>当前冻结</em>}</strong><span>{formatDate(version.savedAt)} · {version.fields.length} 字段 · {version.rules.length} 条规则</span></div><div className="version-actions">{!version.frozen && <button className="text-button" onClick={onContinue}>从此版本继续</button>}<button className="text-button" onClick={onCopy}>复制为项目</button><span className={version.frozen ? 'version-state frozen' : 'version-state'}>{version.frozen ? '◈ 已冻结' : '◷ 快照'}</span></div></article>;
}

function formatDate(time: number): string {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(time);
}
