import type { BusinessRule, FieldDomainSnapshot, RuleAnalysis, RuleFinding, RuleProject, RuleVersion, SampleInput, ShadowSegment, TermCause } from '../../models/ruleModel';
import type { WorkspaceState } from '../../viewmodels/workspaceViewModel';
import type { InspectionViewModel } from './inspectionViewModel';

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
      {analysis && <AnalysisPanel analysis={analysis} project={project as RuleProject} byId={byId} onOpenRule={onOpenRule} viewModel={viewModel} />}

      <section className="versions-section">
        <div className="versions-heading"><div><span className="eyebrow">CHANGE HISTORY</span><h2>规则版本</h2><p>保存检查前后的结构快照。冻结后，当前规则只能通过复制版本继续修改。</p></div><div className="button-row"><button className="button button-subtle" disabled={!rules.length} onClick={() => viewModel.saveVersion()}>＋ 保存版本</button><button className="button button-outline" disabled={!rules.length || Boolean(project?.frozenVersionId)} onClick={() => viewModel.freeze()}>◈ 冻结当前</button></div></div>
        {project?.versions.length ? <div className="version-list">{project.versions.map((version, index) => <VersionRow key={version.id} version={version} index={index} current={project.frozenVersionId === version.id} onContinue={() => viewModel.continueFrom(version.id)} onCopy={() => viewModel.copyToProject(version.id)} />)}</div> : <div className="version-empty card-surface"><span>◷</span><p>还没有保存版本。规则结构和检查结果确认后，可以创建第一个快照。</p></div>}
      </section>
    </section>
  );
}

interface AnalysisPanelProps { analysis: RuleAnalysis; project: RuleProject; byId: Map<string, BusinessRule>; onOpenRule: (ruleId: string) => void; viewModel: InspectionViewModel }

function AnalysisPanel({ analysis, project, byId, onOpenRule, viewModel }: AnalysisPanelProps) {
  const conflictCount = analysis.overlaps.filter((overlap) => overlap.conflict).length;
  const overlapCount = analysis.overlaps.length;
  const coveredRules = Math.max(0, project.rules.length - analysis.unreachableRuleIds.length);
  const unreachableFindings = analysis.findings.filter((finding): finding is Extract<RuleFinding, { kind: 'unreachable' }> => finding.kind === 'unreachable');
  const shadowedFindings = analysis.findings.filter((finding): finding is Extract<RuleFinding, { kind: 'shadowed' }> => finding.kind === 'shadowed');
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
        {analysis.uncoveredExamples.length ? <div className="finding-list">{analysis.uncoveredExamples.map((example, index) => <div className="uncovered-row" key={index}><span className="uncovered-index">0{index + 1}</span><div><strong>未命中输入组合</strong><span>{formatWitness(example, project)}</span></div><span className="severity-tag severity-warn">未覆盖</span></div>)}</div> : <SuccessEmpty text="输入空间已完整覆盖" />}
      </section>
      <section className="analysis-card card-surface"><header className="analysis-card-heading"><span className="analysis-icon unreachable-icon">⊘</span><div><h2>不可达规则</h2><p>条件要求与字段合法取值现场核对后的结论，含失败分支与可复现输入。</p></div><b>{analysis.unreachableRuleIds.length}</b></header>
        {unreachableFindings.length ? <div className="diagnosis-list">{unreachableFindings.map((finding) => <UnreachableCard key={finding.ruleId} finding={finding} project={project} byId={byId} onOpenRule={onOpenRule} onReplay={() => viewModel.replay(finding.repro)} />)}</div> : analysis.unreachableRuleIds.length ? <FallbackRules ids={analysis.unreachableRuleIds} onOpenRule={onOpenRule} byId={byId} /> : <SuccessEmpty text="所有规则都存在可命中输入" />}
      </section>
      <section className="analysis-card card-surface"><header className="analysis-card-heading"><span className="analysis-icon hidden-icon">◉</span><div><h2>被完全遮蔽</h2><p>逐段标出命中区域被哪条更早规则吃掉，并可直接送进样例推演复现。</p></div><b>{analysis.shadowedRuleIds.length}</b></header>
        {shadowedFindings.length ? <div className="diagnosis-list">{shadowedFindings.map((finding) => <ShadowedCard key={finding.ruleId} finding={finding} project={project} byId={byId} onOpenRule={onOpenRule} onReplay={() => viewModel.replay(finding.repro)} />)}</div> : analysis.shadowedRuleIds.length ? <FallbackRules ids={analysis.shadowedRuleIds} onOpenRule={onOpenRule} byId={byId} /> : <SuccessEmpty text="没有被完全遮蔽的规则" />}
      </section>
    </div>
  </>;
}

interface DiagnosisCardProps {
  finding: Extract<RuleFinding, { kind: 'unreachable' }>;
  project: RuleProject;
  byId: Map<string, BusinessRule>;
  onOpenRule: (ruleId: string) => void;
  onReplay: () => void;
}

function UnreachableCard({ finding, project, byId, onOpenRule, onReplay }: DiagnosisCardProps) {
  const rule = byId.get(finding.ruleId);
  return <article className="diagnosis-card">
    <header className="diagnosis-head">
      <button className="inline-rule-link diagnosis-rule" onClick={() => onOpenRule(finding.ruleId)}>{rule?.name ?? finding.ruleId}</button>
      <span className="severity-tag severity-warn">合法取值内永不可达</span>
    </header>
    {finding.blockedTerms.length ? <div className="diagnosis-body">
      <p className="diagnosis-intro">规则按“或”拆出的条件分支，在字段合法范围内都走不通（展示其中 {finding.blockedTerms.length} 个）：</p>
      {finding.blockedTerms.map((term, index) => <div className="reason-block" key={index}>
        <div className="reason-branch"><b>分支 {index + 1}</b><span className="reason-conjunction">{term.requirements.map((item) => item.text).join(' 且 ') || '无条件（恒成立，不该出现在这里）'}</span></div>
        {term.causes.map((cause, causeIndex) => <p className="reason-line" key={causeIndex}><span className="reason-bullet">!</span>{describeCause(cause, project)}</p>)}
      </div>)}
    </div> : <p className="diagnosis-body diagnosis-intro">在当前字段合法取值范围内，该规则条件组合从未成立。</p>}
    <footer className="diagnosis-foot">
      <div className="replay-values"><span>复现输入</span><strong>{formatWitness(finding.repro.values, project)}</strong>{!finding.repro.valid && <em>{finding.repro.invalidFieldIds.map((id) => project.fields.find((field) => field.id === id)?.name).filter(Boolean).join('、')} 超出合法范围，推演会先报错</em>}</div>
      <button className="button button-subtle replay-button" onClick={onReplay}>送进样例推演 ↗</button>
    </footer>
  </article>;
}

interface ShadowedCardProps {
  finding: Extract<RuleFinding, { kind: 'shadowed' }>;
  project: RuleProject;
  byId: Map<string, BusinessRule>;
  onOpenRule: (ruleId: string) => void;
  onReplay: () => void;
}

function ShadowedCard({ finding, project, byId, onOpenRule, onReplay }: ShadowedCardProps) {
  const rule = byId.get(finding.ruleId);
  return <article className="diagnosis-card">
    <header className="diagnosis-head">
      <button className="inline-rule-link diagnosis-rule" onClick={() => onOpenRule(finding.ruleId)}>{rule?.name ?? finding.ruleId}</button>
      <span className="severity-tag severity-danger">命中区域全部被遮蔽</span>
    </header>
    <div className="diagnosis-body">
      <p className="diagnosis-intro">该规则能命中，但它的命中区域被更早的规则分段吃光（首条命中者决定结果）：</p>
      {finding.segments.slice(0, 6).map((segment, index) => <ShadowSegmentRow key={index} segment={segment} project={project} byId={byId} onOpenRule={onOpenRule} />)}
      {finding.truncated && <p className="reason-line reason-more">范围分片较多，仅展示前几段；可用下方复现输入继续核对。</p>}
    </div>
    <footer className="diagnosis-foot">
      <div className="replay-values"><span>复现输入</span><strong>{formatWitness(finding.repro.values, project)}</strong><em>{finding.repro.expected}</em></div>
      <button className="button button-subtle replay-button" onClick={onReplay}>送进样例推演 ↗</button>
    </footer>
  </article>;
}

function ShadowSegmentRow({ segment, project, byId, onOpenRule }: { segment: ShadowSegment; project: RuleProject; byId: Map<string, BusinessRule>; onOpenRule: (ruleId: string) => void }) {
  const other = byId.get(segment.byRuleId);
  const rangeText = Object.entries(segment.range).map(([fieldId, domain]) => {
    const field = project.fields.find((candidate) => candidate.id === fieldId);
    return field ? `${field.name} ${describeDomain(domain)}` : '';
  }).filter(Boolean).join(' · ');
  return <div className="reason-block segment-block">
    <p className="reason-line"><span className="reason-bullet">→</span>当 <strong>{rangeText || '任意合法输入'}</strong> 时，被更早的<button className="inline-rule-link segment-link" onClick={() => onOpenRule(segment.byRuleId)}>{other?.name ?? segment.byRuleId}</button>先命中吃掉。</p>
    <p className="reason-line reason-witness">本组见证：{formatWitness(segment.witness, project)}</p>
  </div>;
}

function FallbackRules({ ids, onOpenRule, byId }: { ids: string[]; onOpenRule: (ruleId: string) => void; byId: Map<string, BusinessRule> }) {
  return <div className="compact-findings">{ids.map((id) => <button className="compact-rule" key={id} onClick={() => onOpenRule(id)}><span>⌁</span><strong>{byId.get(id)?.name ?? id}</strong><i>查看规则 →</i></button>)}</div>;
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

function fieldName(project: RuleProject, fieldId: string): string {
  return project.fields.find((field) => field.id === fieldId)?.name ?? fieldId;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

/** 把一段输入范围渲染成可核对的文字（只包含被收窄的字段）。 */
function describeDomain(domain: FieldDomainSnapshot): string {
  if (domain.kind === 'number') {
    if (domain.min === domain.max && domain.minInclusive && domain.maxInclusive) return `= ${formatNumber(domain.min)}`;
    return `${domain.minInclusive ? '[' : '('}${formatNumber(domain.min)} ~ ${formatNumber(domain.max)}${domain.maxInclusive ? ']' : ')'}`;
  }
  if (domain.kind === 'enum') return domain.values.length === 1 ? `= ${domain.values[0]}` : `∈ {${domain.values.join('、')}}`;
  if (domain.values.length === 1) return `= ${domain.values[0] ? '是' : '否'}`;
  return '为是或否';
}

/** 不可达原因的中文结论：说明哪个条件在合法取值里取不到，或哪两条要求互相矛盾。 */
function describeCause(cause: TermCause, project: RuleProject): string {
  const name = fieldName(project, cause.fieldId);
  if (cause.kind === 'number-gap') {
    const { legal, lower, upper } = cause;
    const legalText = `「${name}」合法范围为 ${legal.minInclusive ? '[' : '('}${formatNumber(legal.min)} ~ ${formatNumber(legal.max)}${legal.maxInclusive ? ']' : ')'}`;
    const boundText = (bound: { value: number; inclusive: boolean }): string =>
      `${formatNumber(bound.value)}${bound.inclusive ? '（含边界）' : '（不含边界）'}`;
    if (lower && upper && lower.value > upper.value) {
      return `${legalText}，但条件同时要求「${name}」大于 ${boundText(lower)}、小于 ${boundText(upper)}，两个要求之间没有任何数。`;
    }
    if (lower && upper && lower.value === upper.value && (!lower.inclusive || !upper.inclusive)) {
      return `${legalText}，但条件要求「${name}」严格大于且严格小于 ${formatNumber(lower.value)}，连 ${formatNumber(lower.value)} 本身也取不到。`;
    }
    if (lower && lower.value > legal.max) {
      return `${legalText}，条件却要求「${name}」${lower.inclusive ? '≥' : '>'} ${formatNumber(lower.value)}，合法值里没有一个满足。`;
    }
    if (lower && lower.value === legal.max && !lower.inclusive) {
      return `${legalText}，条件要求「${name}」严格 ${'>'} ${formatNumber(lower.value)}，而合法范围的终点 ${formatNumber(legal.max)} 也不能取。`;
    }
    if (upper && upper.value < legal.min) {
      return `${legalText}，条件却要求「${name}」${upper.inclusive ? '≤' : '<'} ${formatNumber(upper.value)}，合法值里没有一个满足。`;
    }
    if (upper && upper.value === legal.min && !upper.inclusive) {
      return `${legalText}，条件要求「${name}」严格 ${'<'} ${formatNumber(upper.value)}，而合法范围的起点 ${formatNumber(legal.min)} 也不能取。`;
    }
    return `${legalText}，条件的上下界在该范围内没有交集。`;
  }
  if (cause.kind === 'enum-gap') {
    const options = cause.legalValues.join('、') || '（空）';
    if (cause.requirement.operator === 'notEq') {
      return `「${name}」只有一个合法选项“${String(cause.requirement.value)}”，条件却要求不等于它，可选值里没有任何满足的输入。`;
    }
    return `「${name}」合法选项只有 ${options}，条件要求的“${String(cause.requirement.value)}”不在选项里，任何合法输入都满足不了。`;
  }
  if (cause.fieldType === 'enum') {
    const legal = cause.legalDomain.kind === 'enum' ? cause.legalDomain.values : [];
    return `「${name}」只能取 ${legal.join('、')}，但分支里的条件 ${cause.requirements.map((item) => `“${item.text}”`).join(' 与 ')} 互相排斥，没有选项能同时满足。`;
  }
  return `「${name}」只能为是或否，但分支同时要求 ${cause.requirements.map((item) => `“${item.text}”`).join(' 与 ')}，两者不可能同时成立。`;
}

function VersionRow({ version, index, current, onContinue, onCopy }: { version: RuleVersion; index: number; current: boolean; onContinue: () => void; onCopy: () => void }) {
  return <article className={`version-row${current ? ' version-current' : ''}`}><span className="version-number">{String(index + 1).padStart(2, '0')}</span><div className="version-copy"><strong>{version.name}{current && <em>当前冻结</em>}</strong><span>{formatDate(version.savedAt)} · {version.fields.length} 字段 · {version.rules.length} 条规则</span></div><div className="version-actions">{!version.frozen && <button className="text-button" onClick={onContinue}>从此版本继续</button>}<button className="text-button" onClick={onCopy}>复制为项目</button><span className={version.frozen ? 'version-state frozen' : 'version-state'}>{version.frozen ? '◈ 已冻结' : '◷ 快照'}</span></div></article>;
}

function formatDate(time: number): string {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(time);
}
