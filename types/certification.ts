export const projectStatuses = [
  'draft',
  'submitted',
  'under_review',
  'supplement_required',
  'approved',
  'rejected'
] as const;

export const evidenceStatuses = ['missing', 'submitted', 'accepted', 'rejected', 'resubmit'] as const;

export type ProjectStatus = (typeof projectStatuses)[number];
export type EvidenceStatus = (typeof evidenceStatuses)[number];

export interface RegulationItem {
  id: string;
  code: string;
  title: string;
  category: '安全' | '环保' | '能耗' | '软件' | '部件';
  required: boolean;
  status: 'complete' | 'missing' | 'conflict';
  coverage: number;
  issues: string[];
}

export interface EvidenceItem {
  id: string;
  projectId: string;
  regulationId: string;
  name: string;
  type: 'test_report' | 'part_list' | 'software_report' | 'exemption' | 'certificate';
  version: string;
  softwareVersion: string;
  configurations: string[];
  status: EvidenceStatus;
  expiryDate?: string;
  note: string;
  updatedAt: string;
  /** 关联的共享报告引用登记 ID（非共享证据为空） */
  reportRefId?: string;
  /** 引用源头换版/撤回后，该证据当前失效的配置 */
  invalidatedConfigurations?: string[];
}

export interface ProjectVersion {
  id: string;
  label: string;
  author: string;
  createdAt: string;
  summary: string;
  changes: string[];
  impactedConfigurations: string[];
}

export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  detail: string;
  createdAt: string;
}

/* ---------------- 共享报告引用账（源头 → 项目登记） ---------------- */

/** 源头共享报告版本状态：active 当前有效；superseded 已换版；withdrawn 已撤回 */
export type SharedReportStatus = 'active' | 'superseded' | 'withdrawn';

export interface SharedReportVersion {
  id: string;
  /** 报告族标识，同族报告共享一个 reportKey（同一电池包试验报告） */
  reportKey: string;
  /** 报告族名称，如“动力电池包安全测试报告” */
  familyName: string;
  /** 对应法规项 */
  regulationId: string;
  /** 文件版本，如 R4 */
  version: string;
  /** 该版本源头声明覆盖的配置 */
  configurations: string[];
  status: SharedReportStatus;
  /** 被哪个新版本替换 */
  supersededById?: string;
  /** 引用的其他共享报告版本（引用链），用于成环检测 */
  dependsOn: string[];
  publishedAt: string;
  withdrawnAt?: string;
  note: string;
}

/** 项目侧对共享报告版本的引用登记 */
export interface ReportReference {
  id: string;
  projectId: string;
  regulationId: string;
  /** 登记引用的源头报告版本 ID */
  reportVersionId: string;
  reportKey: string;
  /** 项目登记时声明要使用该报告覆盖的配置 */
  configurations: string[];
  registeredAt: string;
  /** 证据失效重算后仍未恢复的配置（源头换版/撤回导致） */
  invalidatedConfigurations: string[];
}

/** 源账同步批次：同步失败后凭完整批次恢复重试，按 batchId 幂等 */
export interface SyncBatch {
  id: string;
  syncedAt: string;
  references: Array<Pick<ReportReference, 'projectId' | 'regulationId' | 'reportVersionId' | 'reportKey' | 'configurations'>>;
  applied: boolean;
  /** 上次同步是否失败（失败后批次保留，等待恢复重试） */
  lastError?: string;
  note: string;
}

/** 冻结在某个时间点的历史提交包 */
export interface SubmissionPackage {
  id: string;
  projectId: string;
  label: string;
  createdAt: string;
  author: string;
  /** 冻结时刻每个法规项的完整性状态 */
  regulationSnapshots: Array<{
    regulationId: string;
    code: string;
    status: RegulationItem['status'];
    coverage: number;
    issues: string[];
  }>;
  /** 冻结时刻引用的共享报告版本（历史提交包不随后续源头换版而改变） */
  references: Array<{
    refId: string;
    reportVersionId: string;
    reportKey: string;
    version: string;
    configurations: string[];
  }>;
  /** 冻结时刻证据的版本指纹 */
  evidenceFingerprints: Array<{
    evidenceId: string;
    name: string;
    version: string;
    configurations: string[];
  }>;
  note: string;
}

/** 引用链路问题：成环或丢失来源 */
export interface ReferenceChainIssue {
  type: 'cycle' | 'missing_source';
  /** 从引用方开始的完整链路（报告版本 ID 或项目引用 ID） */
  chain: string[];
  detail: string;
}

export interface ReferenceView extends ReportReference {
  reportVersion?: SharedReportVersion;
  familyName: string;
  reportVersionLabel: string;
  /** 登记覆盖配置中当前仍有效的配置 */
  validConfigurations: string[];
  /** 因源头换版/撤回失效的配置 */
  staleConfigurations: string[];
  /** 登记覆盖但源头版本本身未覆盖的配置 */
  uncoveredConfigurations: string[];
}

export interface LedgerState {
  reports: SharedReportVersion[];
  references: ReportReference[];
  batches: SyncBatch[];
}

export interface PublishGateResult {
  allowed: boolean;
  issues: string[];
  chainIssues: ReferenceChainIssue[];
}

export interface ApprovalProject {
  id: string;
  name: string;
  modelCode: string;
  vehicleType: string;
  configuration: string;
  maintenanceVersion: string;
  softwareVersion: string;
  status: ProjectStatus;
  progress: number;
  applicant: string;
  reviewer: string;
  agency: string;
  submittedAt?: string;
  updatedAt: string;
  certificateExpiry: string;
  regulations: RegulationItem[];
  evidence: EvidenceItem[];
  versions: ProjectVersion[];
  audit: AuditEntry[];
  /** 历史提交包（按各自冻结时间点保存，源头后续换版不回改） */
  packages: SubmissionPackage[];
}

export interface ProjectInput {
  name: string;
  modelCode: string;
  vehicleType: string;
  configuration: string;
  maintenanceVersion: string;
  softwareVersion: string;
  applicant: string;
  agency: string;
  certificateExpiry: string;
}

export interface ProjectFilters {
  query: string;
  status: ProjectStatus | 'all';
  agency: string | 'all';
  risk: 'all' | 'expiring' | 'missing' | 'version_conflict';
}
