import type {
  ApprovalProject,
  ProjectInput,
  ReferenceChainFinding,
  ReportReference,
  SharedReport
} from '~/types/certification';

export function validateProjectInput(input: ProjectInput) {
  const errors: Partial<Record<keyof ProjectInput, string>> = {};

  if (input.name.trim().length < 3) errors.name = '项目名称至少 3 个字符';
  if (!/^[A-Za-z0-9-]{3,}$/.test(input.modelCode.trim())) errors.modelCode = '车型代码只能包含字母、数字和连字符';
  if (!input.vehicleType.trim()) errors.vehicleType = '请选择车辆类别';
  if (input.configuration.trim().length < 2) errors.configuration = '请填写配置名称';
  if (!/^MY\d{2}\.\d+$/.test(input.maintenanceVersion.trim())) errors.maintenanceVersion = '维护版本格式应类似 MY27.1';
  if (!/^\d+\.\d+\.\d+$/.test(input.softwareVersion.trim())) errors.softwareVersion = '软件版本格式应类似 8.4.1';
  if (input.applicant.trim().length < 2) errors.applicant = '请填写申请主体';
  if (input.agency.trim().length < 2) errors.agency = '请选择认证机构';
  if (!input.certificateExpiry) errors.certificateExpiry = '请选择证书有效期';

  return errors;
}

export interface SubmissionLedgerContext {
  references: ReportReference[];
  reports: SharedReport[];
  holds: ReferenceChainFinding[];
}

export function validateSubmission(project: ApprovalProject, ledger?: SubmissionLedgerContext) {
  const issues: string[] = [];
  const requiredRegulations = project.regulations.filter((item) => item.required);
  const missingEvidence = project.evidence.filter((item) =>
    ['missing', 'rejected', 'resubmit'].includes(item.status)
  );
  const versionMismatch = project.evidence.filter(
    (item) => item.softwareVersion !== project.softwareVersion
  );
  const coverageIssue = requiredRegulations.find((item) => item.status !== 'complete');
  const expiring = new Date(project.certificateExpiry) <= new Date('2026-12-31');

  if (missingEvidence.length) issues.push(`${missingEvidence.length} 项证据缺失、被拒或待补件`);
  if (versionMismatch.length) issues.push(`${versionMismatch.length} 项证据软件版本与项目基线不一致`);
  if (coverageIssue) issues.push(`法规项 ${coverageIssue.code} 尚未完整覆盖配置`);
  if (expiring) issues.push('证书有效期不足 90 天，需先确认续证安排');

  if (ledger) {
    ledger.references
      .filter((ref) => ref.projectId === project.id && ref.status === 'registered')
      .forEach((ref) => {
        const report = ledger.reports.find((item) => item.id === ref.reportId);
        if (!report) return; // 丢失来源在发布阻断链路中列出
        if (report.status === 'withdrawn') {
          issues.push(`共享报告 ${ref.reportId} 已撤回，引用 ${ref.id} 需重新登记来源`);
        } else if (report.currentVersion !== ref.reportVersion) {
          issues.push(`共享报告 ${ref.reportId} 已换版至 ${report.currentVersion}，引用版本 ${ref.reportVersion} 失效`);
        }
      });
    ledger.holds.forEach((hold) => {
      issues.push(`${hold.kind === 'cycle' ? '引用链成环' : '引用来源缺失'}：${hold.chain.join(' → ')}，发布已停住`);
    });
  }

  return issues;
}

export function validateEvidenceUpgrade(project: ApprovalProject, evidenceIds: string[], note: string) {
  const errors: string[] = [];
  if (!evidenceIds.length) errors.push('至少选择一项待补件证据');
  if (note.trim().length < 6) errors.push('批量补件说明至少 6 个字符');
  const selected = project.evidence.filter((item) => evidenceIds.includes(item.id));
  if (!selected.length) errors.push('所选证据不属于当前项目');
  return errors;
}
