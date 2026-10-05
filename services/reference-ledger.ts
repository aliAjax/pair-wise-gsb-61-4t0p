import type {
  ApprovalProject,
  LedgerState,
  PublishGateResult,
  ReferenceChainIssue,
  ReferenceView,
  ReportReference,
  SharedReportVersion,
  SubmissionPackage,
  SyncBatch
} from '~/types/certification';

/* =====================================================================
 * 共享报告引用账 —— 纯逻辑层（不依赖 pinia / localStorage，便于测试）
 *
 * 关系：源头共享报告版本 (SharedReportVersion)
 *         └─ 项目登记引用 (ReportReference)：登记引用的报告版本 + 覆盖配置
 *              └─ 项目证据 (EvidenceItem.reportRefId)
 *
 * 规则：
 *  - 源头换版 / 撤回后，只让“受影响配置”的证据失效重算，
 *    其他项目、其他配置仍视作有效证据。
 *  - 引用重新登记到新版本（含源账批次同步）后，覆盖配置恢复有效。
 *  - 法规完整性、审批阻断按当前时间点实时计算；历史提交包冻结在各自时间点。
 *  - 源账同步以完整批次为单位：失败保留批次、可恢复重试；
 *    已应用批次重复同步直接跳过，不反复回退。
 *  - 引用成环或丢失来源时列出完整链路并停住发布。
 * ===================================================================== */

export const LEDGER_ISSUE_TAG = '【引用账】';

export function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 10)}`;
}

export function emptyLedger(): LedgerState {
  return { reports: [], references: [], batches: [] };
}

export function findReport(reports: SharedReportVersion[], id: string) {
  return reports.find((report) => report.id === id);
}

export function reportLabel(reports: SharedReportVersion[], id: string | undefined) {
  if (!id) return '（空）';
  const report = findReport(reports, id);
  return report ? `${report.familyName} ${report.version}` : id;
}

/** 沿 supersededById 找到族内最新版本 */
export function newestOfLineage(reports: SharedReportVersion[], report: SharedReportVersion): SharedReportVersion {
  let current = report;
  const seen = new Set<string>([current.id]);
  while (current.supersededById) {
    const next = findReport(reports, current.supersededById);
    if (!next || seen.has(next.id)) break;
    seen.add(next.id);
    current = next;
  }
  return current;
}

export function activeReportsOfFamily(reports: SharedReportVersion[], reportKey: string) {
  return reports.filter((report) => report.reportKey === reportKey && report.status === 'active');
}

export type ReferenceHealth = {
  status: 'valid' | 'superseded' | 'withdrawn' | 'missing';
  source?: SharedReportVersion;
  successor?: SharedReportVersion;
  /** 登记覆盖且当前仍有效的配置 */
  valid: string[];
  /** 源头换版/撤回导致失效的配置 */
  stale: string[];
  /** 新版本已覆盖、重新登记后可恢复的配置 */
  refreshable: string[];
  /** 登记覆盖但源头版本本身未覆盖的配置（超登记） */
  uncovered: string[];
  reason: string;
};

export function referenceHealth(ref: ReportReference, reports: SharedReportVersion[]): ReferenceHealth {
  const source = findReport(reports, ref.reportVersionId);
  if (!source) {
    return {
      status: 'missing',
      valid: [],
      stale: [...ref.configurations],
      refreshable: [],
      uncovered: [],
      reason: '源头报告版本丢失'
    };
  }
  if (source.status === 'withdrawn') {
    return {
      status: 'withdrawn',
      source,
      valid: [],
      stale: [...ref.configurations],
      refreshable: [],
      uncovered: [],
      reason: `源头${source.familyName} ${source.version} 已撤回`
    };
  }
  if (source.status === 'superseded') {
    const successor = newestOfLineage(reports, source);
    const refreshable = ref.configurations.filter((config) => successor.configurations.includes(config));
    return {
      status: 'superseded',
      source,
      successor,
      valid: [],
      stale: [...ref.configurations],
      refreshable,
      uncovered: [],
      reason: `源头${source.familyName} ${source.version} 已换版至 ${successor.version}`
    };
  }
  const uncovered = ref.configurations.filter((config) => !source.configurations.includes(config));
  const valid = ref.configurations.filter((config) => source.configurations.includes(config));
  return {
    status: 'valid',
    source,
    valid,
    stale: [],
    refreshable: [],
    uncovered,
    reason: uncovered.length ? '部分登记配置不在源头报告覆盖范围内' : ''
  };
}

/** 一份引用当前确定失效的配置（换版/撤回/丢失 + 超登记覆盖） */
export function invalidConfigsOf(ref: ReportReference, reports: SharedReportVersion[]): string[] {
  const health = referenceHealth(ref, reports);
  return Array.from(new Set([...health.stale, ...health.uncovered]));
}

/* --------------------------- 引用链路检测 --------------------------- */

/** 检测引用成环与丢失来源，返回每条问题的完整链路 */
export function detectChainIssues(ledger: LedgerState): ReferenceChainIssue[] {
  const { reports, references } = ledger;
  const reportIds = new Set(reports.map((report) => report.id));
  const issues: ReferenceChainIssue[] = [];

  // 丢失来源：引用指向不存在的报告版本
  for (const ref of references) {
    if (!reportIds.has(ref.reportVersionId)) {
      issues.push({
        type: 'missing_source',
        chain: [ref.id, ref.reportVersionId],
        detail: `项目 ${ref.projectId} 的引用 ${ref.id} 指向已丢失的源头版本 ${ref.reportVersionId}`
      });
    }
  }

  // 丢失来源：报告 dependsOn 指向不存在的版本
  for (const report of reports) {
    for (const dep of report.dependsOn) {
      if (!reportIds.has(dep)) {
        issues.push({
          type: 'missing_source',
          chain: [report.id, dep],
          detail: `${reportLabel(reports, report.id)} 依赖的来源版本 ${dep} 不存在`
        });
      }
    }
  }

  // 成环检测：dependsOn 有向图 DFS
  const adjacency = new Map<string, string[]>();
  for (const report of reports) adjacency.set(report.id, report.dependsOn.filter((dep) => reportIds.has(dep)));

  const state = new Map<string, 0 | 1 | 2>(); // 0 未访问 1 在栈中 2 完成
  const stack: string[] = [];
  const cycles: string[][] = [];

  const visit = (node: string) => {
    state.set(node, 1);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const mark = state.get(next) ?? 0;
      if (mark === 0) {
        visit(next);
      } else if (mark === 1 && !cycles.some((cycle) => cycle[0] === next)) {
        const start = stack.indexOf(next);
        cycles.push([...stack.slice(start), next]);
      }
    }
    stack.pop();
    state.set(node, 2);
  };

  for (const report of reports) {
    if ((state.get(report.id) ?? 0) === 0) visit(report.id);
  }

  for (const cycle of cycles) {
    issues.push({
      type: 'cycle',
      chain: cycle,
      detail: `检测到引用成环：${cycle.map((id) => reportLabel(reports, id)).join(' → ')}`
    });
  }

  return issues;
}

/* ----------------------- 源头报告发布 / 撤回 ----------------------- */

export interface PublishReportInput {
  reportKey?: string;
  familyName: string;
  regulationId: string;
  version: string;
  configurations: string[];
  dependsOn?: string[];
  note?: string;
  /** 显式声明被替换的版本；缺省时替换同族全部 active 版本 */
  supersedesIds?: string[];
}

/** 发布新版源头报告：旧版标记 superseded，返回新版本 ID */
export function publishReportVersion(ledger: LedgerState, input: PublishReportInput, at = nowIso()): string {
  const sameVersion = ledger.reports.find(
    (report) =>
      (report.reportKey === input.reportKey || report.familyName === input.familyName) && report.version === input.version
  );
  if (sameVersion) {
    throw new Error(`源头已存在 ${input.familyName} ${input.version}，不能重复发布`);
  }

  const reportKey = input.reportKey ?? makeId('KEY');
  const newId = makeId('SR');
  const previous = input.supersedesIds
    ? ledger.reports.filter((report) => input.supersedesIds!.includes(report.id))
    : activeReportsOfFamily(ledger.reports, reportKey);

  const version: SharedReportVersion = {
    id: newId,
    reportKey,
    familyName: input.familyName,
    regulationId: input.regulationId,
    version: input.version,
    configurations: [...new Set(input.configurations)],
    status: 'active',
    dependsOn: input.dependsOn ?? [],
    publishedAt: at,
    note: input.note ?? ''
  };
  ledger.reports.push(version);

  for (const old of previous) {
    old.status = 'superseded';
    old.supersededById = newId;
  }
  return newId;
}

export function withdrawReportVersion(ledger: LedgerState, versionId: string, _reason: string, at = nowIso()): boolean {
  const report = findReport(ledger.reports, versionId);
  if (!report) return false;
  report.status = 'withdrawn';
  report.withdrawnAt = at;
  report.supersededById = undefined;
  return true;
}

/* ----------------------------- 引用登记 ----------------------------- */

export interface RegisterReferenceInput {
  projectId: string;
  regulationId: string;
  reportVersionId: string;
  configurations: string[];
}

/** 登记或刷新项目引用（同 项目+法规+报告族 视为同一笔引用，重新登记即换版刷新） */
export function registerReference(
  ledger: LedgerState,
  input: RegisterReferenceInput,
  at = nowIso()
): ReportReference {
  const report = findReport(ledger.reports, input.reportVersionId);
  if (!report) throw new Error(`源头报告版本 ${input.reportVersionId} 不存在，不能登记引用`);

  const existing = ledger.references.find(
    (ref) => ref.projectId === input.projectId && ref.regulationId === input.regulationId && ref.reportKey === report.reportKey
  );
  if (existing) {
    existing.reportVersionId = input.reportVersionId;
    existing.configurations = [...new Set(input.configurations)];
    existing.registeredAt = at;
    existing.invalidatedConfigurations = invalidConfigsOf(existing, ledger.reports);
    return existing;
  }

  const ref: ReportReference = {
    id: makeId('RR'),
    projectId: input.projectId,
    regulationId: input.regulationId,
    reportVersionId: input.reportVersionId,
    reportKey: report.reportKey,
    configurations: [...new Set(input.configurations)],
    registeredAt: at,
    invalidatedConfigurations: []
  };
  ref.invalidatedConfigurations = invalidConfigsOf(ref, ledger.reports);
  ledger.references.push(ref);
  return ref;
}

export function referencesForProject(ledger: LedgerState, projectId: string) {
  return ledger.references.filter((ref) => ref.projectId === projectId);
}

export function referenceView(ledger: LedgerState, ref: ReportReference): ReferenceView {
  const health = referenceHealth(ref, ledger.reports);
  return {
    ...ref,
    reportVersion: health.source,
    familyName: health.source?.familyName ?? ref.reportKey,
    reportVersionLabel: health.source ? health.source.version : '来源丢失',
    validConfigurations: health.valid,
    staleConfigurations: health.stale,
    uncoveredConfigurations: health.uncovered
  };
}

/* --------------------------- 证据失效重算 --------------------------- */

export interface RecomputeChange {
  projectId: string;
  invalidatedEvidence: Array<{ evidenceId: string; configs: string[]; reason: string }>;
  restoredEvidence: string[];
}

/**
 * 重算引用账失效面：更新引用/证据的失效配置，刷新各项目法规完整性。
 * 只改动真正发生变化的证据，重复执行不会反复回退或刷审计。
 */
export function recompute(ledger: LedgerState, projects: ApprovalProject[], at = nowIso()): RecomputeChange[] {
  const changes = new Map<string, RecomputeChange>();
  const changeOf = (projectId: string) => {
    let change = changes.get(projectId);
    if (!change) {
      change = { projectId, invalidatedEvidence: [], restoredEvidence: [] };
      changes.set(projectId, change);
    }
    return change;
  };

  // 1) 刷新引用级失效配置（先拍旧值，供证据恢复判断）
  const previousInvalid = new Map<string, string[]>();
  for (const ref of ledger.references) {
    previousInvalid.set(ref.id, [...ref.invalidatedConfigurations]);
    ref.invalidatedConfigurations = invalidConfigsOf(ref, ledger.reports);
  }

  // 2) 证据级失效 / 恢复
  for (const project of projects) {
    for (const evidence of project.evidence) {
      if (!evidence.reportRefId) continue;
      const ref = ledger.references.find((item) => item.id === evidence.reportRefId);
      const nextInvalid = ref
        ? evidence.configurations.filter((config) => ref.invalidatedConfigurations.includes(config))
        : [...evidence.configurations]; // 引用本身丢失
      const prevInvalid = new Set(evidence.invalidatedConfigurations ?? []);
      const nextSet = new Set(nextInvalid);

      if (nextInvalid.length > 0 && (nextInvalid.length !== prevInvalid.size || nextInvalid.some((c) => !prevInvalid.has(c)))) {
        evidence.invalidatedConfigurations = nextInvalid;
        if (evidence.status === 'accepted' || evidence.status === 'submitted') {
          const reason = ref ? referenceHealth(ref, ledger.reports).reason : '引用登记丢失';
          evidence.status = 'resubmit';
          evidence.note = `${LEDGER_ISSUE_TAG}自动失效 ${reason}，配置 ${nextInvalid.join('、')} 的证据已失效，需重算后重新提交。`;
        }
        evidence.updatedAt = at;
        changeOf(project.id).invalidatedEvidence.push({ evidenceId: evidence.id, configs: nextInvalid, reason: '引用源头变更' });
      } else if (nextInvalid.length === 0 && prevInvalid.size > 0) {
        evidence.invalidatedConfigurations = [];
        // 仅自动恢复“由引用账自动转成 resubmit”的证据；审阅人手动拒绝/退回的不自动翻案
        if (evidence.status === 'resubmit' && evidence.note.startsWith(`${LEDGER_ISSUE_TAG}自动失效`)) {
          evidence.status = 'submitted';
          evidence.note = `${LEDGER_ISSUE_TAG}已重新引用当前有效源头版本，证据恢复有效，待审阅人确认。`;
          changeOf(project.id).restoredEvidence.push(evidence.id);
        }
        evidence.updatedAt = at;
      }
    }
  }

  // 3) 法规完整性按当前时间点重算
  for (const project of projects) recomputeRegulations(project, ledger);

  return [...changes.values()];
}

/** 单个法规项的实时完整性（当前时间点） */
export function computeRegulationState(
  project: ApprovalProject,
  ledger: LedgerState,
  regulationId: string
): { status: 'complete' | 'missing' | 'conflict'; coverage: number; issues: string[] } {
  const refs = ledger.references.filter(
    (ref) => ref.projectId === project.id && ref.regulationId === regulationId
  );
  const evidences = project.evidence.filter((item) => item.regulationId === regulationId);
  const existing = project.regulations.find((item) => item.id === regulationId);

  // 既无证据也无共享引用的法规项不受引用账管辖，保持其登记状态
  if (!refs.length && !evidences.length && existing) {
    return { status: existing.status, coverage: existing.coverage, issues: [...existing.issues] };
  }
  const expected = new Set<string>();
  refs.forEach((ref) => ref.configurations.forEach((config) => expected.add(config)));
  evidences.forEach((evidence) => evidence.configurations.forEach((config) => expected.add(config)));

  const issues: string[] = [];
  if (!evidences.length && !refs.length) {
    issues.push('尚未关联测试报告或共享引用');
    return { status: 'missing', coverage: 0, issues };
  }

  for (const ref of refs) {
    const health = referenceHealth(ref, ledger.reports);
    if (health.status === 'missing') {
      issues.push(`共享引用 ${ref.id} 指向的源头版本已丢失：配置 ${ref.configurations.join('、')} 全部失效`);
    } else if (health.status === 'withdrawn') {
      issues.push(`${health.reason}：配置 ${health.stale.join('、')} 证据失效，需重新试验`);
    } else if (health.status === 'superseded') {
      const lost = health.stale.filter((config) => !health.refreshable.includes(config));
      issues.push(
        `${health.reason}：配置 ${health.stale.join('、')} 的证据待重算` +
          (lost.length ? `；其中 ${lost.join('、')} 在新版报告中不再覆盖` : '')
      );
    } else if (health.uncovered.length) {
      issues.push(`登记配置 ${health.uncovered.join('、')} 超出源头报告 ${health.source!.version} 的覆盖范围`);
    }
  }

  const covered = new Set<string>();
  for (const evidence of evidences) {
    const invalid = new Set(evidence.invalidatedConfigurations ?? []);
    if (evidence.status === 'accepted') {
      evidence.configurations.filter((config) => !invalid.has(config)).forEach((config) => covered.add(config));
    } else if (invalid.size) {
      issues.push(`${evidence.name} 的配置 ${[...invalid].join('、')} 已失效（状态：${evidence.status}）`);
    } else {
      issues.push(`${evidence.name} 当前为${evidence.status}，配置 ${evidence.configurations.join('、')} 尚未获接受`);
    }
    if (evidence.softwareVersion !== project.softwareVersion) {
      issues.push(`${evidence.name} 软件版本 ${evidence.softwareVersion} 与项目基线 ${project.softwareVersion} 不一致`);
    }
  }

  const total = expected.size || 1;
  const coverage = Math.round((covered.size / total) * 100);
  const uncoveredConfigs = [...expected].filter((config) => !covered.has(config));
  if (uncoveredConfigs.length && coverage > 0) {
    issues.push(`配置 ${uncoveredConfigs.join('、')} 缺少已接受的有效证据`);
  }

  const hasConflict = refs.some((ref) => {
    const health = referenceHealth(ref, ledger.reports);
    return health.status !== 'valid' || health.uncovered.length > 0;
  });
  const versionConflict = evidences.some((evidence) => evidence.softwareVersion !== project.softwareVersion);

  let status: 'complete' | 'missing' | 'conflict';
  if (coverage < 100) status = hasConflict || versionConflict ? 'conflict' : 'missing';
  else if (hasConflict || versionConflict || issues.length) status = 'conflict';
  else status = 'complete';

  return { status, coverage: Math.min(coverage, 100), issues };
}

/** 重算项目全部法规项并回写；返回平均覆盖率用于进度 */
export function recomputeRegulations(project: ApprovalProject, ledger: LedgerState): number {
  for (const regulation of project.regulations) {
    const computed = computeRegulationState(project, ledger, regulation.id);
    regulation.status = computed.status;
    regulation.coverage = computed.coverage;
    regulation.issues = computed.issues;
  }
  const coverages = project.regulations.map((regulation) => regulation.coverage);
  return coverages.length ? Math.round(coverages.reduce((sum, value) => sum + value, 0) / coverages.length) : 0;
}

/* ------------------------- 源账批次同步（幂等） ------------------------- */

export interface BatchInput {
  note: string;
  references: RegisterReferenceInput[];
}

export interface BatchResult {
  batchId: string;
  applied: boolean;
  alreadyApplied: boolean;
  error?: string;
  changes: RecomputeChange[];
}

/**
 * 以完整引用批次同步源账。
 * - simulateFailure 时整批不落账，批次保留 applied=false，等待恢复重试；
 * - 已应用批次再次同步直接返回 alreadyApplied，不回退、不重算。
 */
export function applySyncBatch(
  ledger: LedgerState,
  projects: ApprovalProject[],
  input: BatchInput,
  options: { batchId?: string; at?: string; simulateFailure?: boolean } = {}
): BatchResult {
  const at = options.at ?? nowIso();
  const batchId = options.batchId ?? makeId('BAT');
  const existing = ledger.batches.find((batch) => batch.id === batchId);

  if (existing?.applied) {
    return { batchId, applied: true, alreadyApplied: true, changes: [] };
  }

  // 失败模拟在任何写入之前发生，保证整批原子性
  if (options.simulateFailure) {
    const error = '源账服务暂不可用（模拟失败），完整批次已保留，可恢复重试';
    if (existing) {
      existing.lastError = error;
    } else {
      ledger.batches.push(toBatchRecord(batchId, input, at, ledger.reports, error));
    }
    return { batchId, applied: false, alreadyApplied: false, error, changes: [] };
  }

  // 校验批次完整性：项目与源头版本必须存在
  for (const item of input.references) {
    if (!findReport(ledger.reports, item.reportVersionId)) {
      const error = `批次引用的源头版本 ${item.reportVersionId} 不存在`;
      if (existing) existing.lastError = error;
      else ledger.batches.push(toBatchRecord(batchId, input, at, ledger.reports, error));
      return { batchId, applied: false, alreadyApplied: false, error, changes: [] };
    }
    if (!projects.some((project) => project.id === item.projectId)) {
      const error = `批次引用的项目 ${item.projectId} 不存在`;
      if (existing) existing.lastError = error;
      else ledger.batches.push(toBatchRecord(batchId, input, at, ledger.reports, error));
      return { batchId, applied: false, alreadyApplied: false, error, changes: [] };
    }
  }

  for (const item of input.references) registerReference(ledger, item, at);

  if (existing) {
    existing.applied = true;
    existing.lastError = undefined;
    existing.syncedAt = at;
    existing.references = input.references.map((item) => {
      const report = findReport(ledger.reports, item.reportVersionId);
      return {
        projectId: item.projectId,
        regulationId: item.regulationId,
        reportVersionId: item.reportVersionId,
        reportKey: report?.reportKey ?? '',
        configurations: [...item.configurations]
      };
    });
  } else {
    ledger.batches.push(toBatchRecord(batchId, input, at, ledger.reports));
  }

  const affectedProjectIds = new Set(input.references.map((item) => item.projectId));
  const affectedProjects = projects.filter((project) => affectedProjectIds.has(project.id));
  const changes = recompute(ledger, affectedProjects, at);
  return { batchId, applied: true, alreadyApplied: false, changes };
}

function toBatchRecord(batchId: string, input: BatchInput, at: string, reports: SharedReportVersion[], error?: string): SyncBatch {
  return {
    id: batchId,
    syncedAt: at,
    references: input.references.map((item) => ({
      projectId: item.projectId,
      regulationId: item.regulationId,
      reportVersionId: item.reportVersionId,
      reportKey: findReport(reports, item.reportVersionId)?.reportKey ?? '',
      configurations: [...item.configurations]
    })),
    applied: false,
    lastError: error,
    note: input.note
  };
}

/* ----------------------------- 发布闸门 ----------------------------- */

export function evaluatePublishGate(
  project: ApprovalProject,
  ledger: LedgerState,
  chainIssues?: ReferenceChainIssue[]
): PublishGateResult {
  const issues: string[] = [];
  const refs = referencesForProject(ledger, project.id);

  for (const ref of refs) {
    const view = referenceView(ledger, ref);
    if (view.staleConfigurations.length || view.uncoveredConfigurations.length) {
      issues.push(
        `共享报告「${view.familyName} ${view.reportVersionLabel}」存在失效配置：` +
          [...view.staleConfigurations, ...view.uncoveredConfigurations].join('、')
      );
    }
  }

  for (const regulation of project.regulations) {
    if (regulation.status !== 'complete') {
      issues.push(`法规项 ${regulation.code} 完整性为 ${regulation.status}（覆盖率 ${regulation.coverage}%）`);
    }
  }

  for (const evidence of project.evidence) {
    if (evidence.reportRefId && !ledger.references.some((ref) => ref.id === evidence.reportRefId)) {
      issues.push(`证据 ${evidence.name} 的引用登记 ${evidence.reportRefId} 已丢失`);
    }
    if ((evidence.invalidatedConfigurations ?? []).length) {
      issues.push(`证据 ${evidence.name} 的配置 ${evidence.invalidatedConfigurations!.join('、')} 已失效待重算`);
    }
    if (evidence.status === 'rejected' || evidence.status === 'resubmit' || evidence.status === 'missing') {
      issues.push(`证据 ${evidence.name} 状态为 ${evidence.status}`);
    }
  }

  const chains = chainIssues ?? detectChainIssues(ledger);
  for (const chain of chains) {
    issues.push(chain.type === 'cycle' ? `引用成环，已停住发布：${chain.detail}` : `来源丢失，已停住发布：${chain.detail}`);
  }

  return { allowed: issues.length === 0, issues, chainIssues: chains };
}

/* --------------------------- 历史提交包冻结 --------------------------- */

export function freezeSubmissionPackage(
  project: ApprovalProject,
  ledger: LedgerState,
  options: { label: string; author: string; note: string; at?: string }
): SubmissionPackage {
  const at = options.at ?? nowIso();
  return {
    id: makeId('PKG'),
    projectId: project.id,
    label: options.label,
    createdAt: at,
    author: options.author,
    regulationSnapshots: project.regulations.map((regulation) => ({
      regulationId: regulation.id,
      code: regulation.code,
      status: regulation.status,
      coverage: regulation.coverage,
      issues: [...regulation.issues]
    })),
    references: referencesForProject(ledger, project.id).map((ref) => {
      const source = findReport(ledger.reports, ref.reportVersionId);
      return {
        refId: ref.id,
        reportVersionId: ref.reportVersionId,
        reportKey: ref.reportKey,
        version: source?.version ?? '来源丢失',
        configurations: [...ref.configurations]
      };
    }),
    evidenceFingerprints: project.evidence.map((evidence) => ({
      evidenceId: evidence.id,
      name: evidence.name,
      version: evidence.version,
      configurations: [...evidence.configurations]
    })),
    note: options.note
  };
}
