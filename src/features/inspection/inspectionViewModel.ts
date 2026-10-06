import type { ReproductionInput } from '../../models/ruleModel';
import type { RuleWorkspaceViewModel } from '../../viewmodels/workspaceViewModel';

export class InspectionViewModel {
  constructor(private readonly workspace: RuleWorkspaceViewModel) {}

  check(): Promise<void> {
    return this.workspace.runCheck();
  }

  cancel(): void {
    this.workspace.cancelCheck();
  }

  /** 把诊断结论附带的复现输入送进样例推演，立即看到同样的结果。 */
  replay(repro: ReproductionInput): void {
    this.workspace.sendToSample(repro.values, repro.expected, repro.valid);
  }

  saveVersion(): void {
    this.workspace.saveVersion();
  }

  freeze(): void {
    this.workspace.freezeCurrent();
  }

  continueFrom(versionId: string): void {
    this.workspace.restoreVersion(versionId);
  }

  copyToProject(versionId: string): void {
    this.workspace.copyVersionToProject(versionId);
  }
}
