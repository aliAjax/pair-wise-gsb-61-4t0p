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
  recomputedAt?: string;
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

export const sharedReportStatuses = ['active', 'withdrawn'] as const;
export type SharedReportStatus = (typeof sharedReportStatuses)[number];

export interface SharedReportVersion {
  version: string;
  issuedAt: string;
  status: 'active' | 'superseded' | 'withdrawn';
  note: string;
}

/** 源账：多车型共用的试验报告（如平台电池包报告），由实验室/源头维护版本。 */
export interface SharedReport {
  id: string;
  name: string;
  regulationId: string;
  owner: string;
  status: SharedReportStatus;
  currentVersion: string;
  versions: SharedReportVersion[];
  updatedAt: string;
}

/** 引用账：项目登记“引用了哪份共享报告的哪个版本、覆盖哪些配置”。 */
export interface ReportReference {
  id: string;
  projectId: string;
  evidenceId: string;
  reportId: string;
  reportVersion: string;
  configurations: string[];
  /** 若引用是复制自其他项目的登记，记录上游引用形成链路。 */
  derivedFrom?: string;
  registeredAt: string;
  status: 'registered' | 'deregistered';
  deregisterReason?: string;
}

export type ReferenceHealth = 'valid' | 'stale' | 'lost_source' | 'cycle' | 'deregistered';

export interface ReferenceChainFinding {
  referenceId: string;
  projectId: string;
  kind: 'cycle' | 'lost_source';
  /** 引用链路，末端为问题点（成环节点或缺失来源）。 */
  chain: string[];
}

export interface SyncBatchItem {
  reportId: string;
  action: 'update' | 'withdraw';
  version?: SharedReportVersion;
}

/** 源账同步批次：一批源头换版/撤回变更。 */
export interface SyncBatch {
  id: string;
  label: string;
  createdAt: string;
  items: SyncBatchItem[];
}

export interface SyncLogEntry {
  id: string;
  batchId: string;
  label: string;
  kind: 'applied' | 'failed' | 'recovered' | 'skipped';
  detail: string;
  createdAt: string;
}

export interface SyncFailure {
  batchId: string;
  label: string;
  reason: string;
  failedAt: string;
  /** 标记该失败是否已执行过回退，保证重复恢复不会反复回退。 */
  recovered: boolean;
  batch: SyncBatch;
}

/** 最后一个完整应用批次时刻的账快照，作为同步失败后的恢复点。 */
export interface SyncCheckpoint {
  batchId: string;
  sharedReports: SharedReport[];
  projects: ApprovalProject[];
}

export interface SubmissionPackageEvidence {
  id: string;
  name: string;
  version: string;
  status: EvidenceStatus;
  configurations: string[];
}

export interface SubmissionPackageReference {
  id: string;
  reportId: string;
  reportVersion: string;
  configurations: string[];
}

/** 历史提交包：在提交/批准/导出时点冻结证据与引用版本，后续源账变更不回写。 */
export interface SubmissionPackage {
  id: string;
  projectId: string;
  reason: 'submit' | 'approve' | 'export';
  createdAt: string;
  evidence: SubmissionPackageEvidence[];
  references: SubmissionPackageReference[];
}
