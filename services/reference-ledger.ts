import type {
  ApprovalProject,
  ReferenceChainFinding,
  ReferenceHealth,
  ReportReference,
  SharedReport,
  SubmissionPackage,
  SyncBatchItem
} from '~/types/certification';

/** 引用账计算所需的最小状态切片。 */
export interface LedgerSlice {
  projects: ApprovalProject[];
  references: ReportReference[];
  sharedReports: SharedReport[];
}

export interface RecomputeEffects {
  invalidated: Array<{
    projectId: string;
    evidenceId: string;
    evidenceName: string;
    configurations: string[];
    cause: 'superseded' | 'withdrawn';
  }>;
  recomputedRegulations: Array<{ projectId: string; regulationId: string }>;
}

type BadgeTone = 'gray' | 'blue' | 'amber' | 'green' | 'red';

export const referenceHealthMeta: Record<ReferenceHealth, { label: string; color: BadgeTone }> = {
  valid: { label: '有效', color: 'green' },
  stale: { label: '版本失效', color: 'amber' },
  lost_source: { label: '来源缺失', color: 'red' },
  cycle: { label: '引用成环', color: 'red' },
  deregistered: { label: '已注销', color: 'gray' }
};

/**
 * 沿 derivedFrom 走访每条引用链：
 * - 回到已访问节点 → 引用成环；
 * - 来源报告不存在、上游引用缺失或已注销 → 丢失来源。
 * 命中的链路原样列出，供页面展示并停住发布。
 */
export function analyzeReferenceChains(
  references: ReportReference[],
  reports: SharedReport[],
  projectId?: string
): ReferenceChainFinding[] {
  const reportIds = new Set(reports.map((report) => report.id));
  const byId = new Map(references.map((ref) => [ref.id, ref]));
  const findings: ReferenceChainFinding[] = [];
  const seen = new Set<string>();

  const starts = references.filter((ref) => ref.status === 'registered' && (!projectId || ref.projectId === projectId));

  for (const start of starts) {
    const chain: string[] = [];
    const visited = new Set<string>();
    let cursor: ReportReference | undefined = start;

    while (cursor) {
      if (visited.has(cursor.id)) {
        chain.push(`${cursor.id}（成环）`);
        const key = `cycle:${[...visited].sort().join('+')}`;
        if (!seen.has(key)) {
          seen.add(key);
          findings.push({ referenceId: start.id, projectId: start.projectId, kind: 'cycle', chain: [...chain] });
        }
        break;
      }
      visited.add(cursor.id);
      chain.push(cursor.id);

      if (!reportIds.has(cursor.reportId)) {
        chain.push(`${cursor.reportId}（来源缺失）`);
        const key = `lost:${cursor.reportId}:${start.projectId}`;
        if (!seen.has(key)) {
          seen.add(key);
          findings.push({ referenceId: start.id, projectId: start.projectId, kind: 'lost_source', chain: [...chain] });
        }
        break;
      }

      if (!cursor.derivedFrom) break;
      const next = byId.get(cursor.derivedFrom);
      if (!next || next.status !== 'registered') {
        chain.push(`${cursor.derivedFrom}（${next ? '已注销，链路断裂' : '上游引用缺失'}）`);
        const key = `lost:${cursor.derivedFrom}:${start.projectId}`;
        if (!seen.has(key)) {
          seen.add(key);
          findings.push({ referenceId: start.id, projectId: start.projectId, kind: 'lost_source', chain: [...chain] });
        }
        break;
      }
      cursor = next;
    }
  }

  return findings;
}

/** 每条引用的健康度：注销 > 链路异常（成环/丢失来源）> 版本落后或源已撤回 > 有效。 */
export function referenceHealthMap(references: ReportReference[], reports: SharedReport[]): Map<string, ReferenceHealth> {
  const map = new Map<string, ReferenceHealth>();
  const findingByRef = new Map<string, ReferenceChainFinding['kind']>();
  analyzeReferenceChains(references, reports).forEach((finding) => {
    finding.chain.forEach((node) => {
      const refId = node.replace(/（.*）/, '');
      if (!findingByRef.has(refId)) findingByRef.set(refId, finding.kind);
    });
  });

  references.forEach((ref) => {
    if (ref.status === 'deregistered') {
      map.set(ref.id, 'deregistered');
      return;
    }
    const finding = findingByRef.get(ref.id);
    if (finding) {
      map.set(ref.id, finding);
      return;
    }
    const report = reports.find((item) => item.id === ref.reportId);
    if (!report) {
      map.set(ref.id, 'lost_source');
      return;
    }
    if (report.status === 'withdrawn' || report.currentVersion !== ref.reportVersion) {
      map.set(ref.id, 'stale');
      return;
    }
    map.set(ref.id, 'valid');
  });

  return map;
}

/** 应用单条源账变更（换版或撤回）。 */
export function applyBatchItem(reports: SharedReport[], item: SyncBatchItem, now: string) {
  const report = reports.find((entry) => entry.id === item.reportId);
  if (!report) return;
  if (item.action === 'withdraw') {
    report.status = 'withdrawn';
    report.versions.forEach((version) => {
      if (version.status === 'active') version.status = 'withdrawn';
    });
  } else if (item.version) {
    report.versions.forEach((version) => {
      if (version.status === 'active') version.status = 'superseded';
    });
    report.versions.push({ ...item.version });
    report.currentVersion = item.version.version;
    report.status = 'active';
  }
  report.updatedAt = now;
}

/**
 * 源头换版/撤回后的失效重算：
 * 登记版本落后于源账现行版本（或源已撤回）的引用，其覆盖配置从对应证据中失效，
 * 证据按配置粒度转为需重交/缺失，并重算受影响法规项的完整性。
 */
export function recomputeSharedReferences(ledger: LedgerSlice, changedReportIds: string[], now: string): RecomputeEffects {
  const effects: RecomputeEffects = { invalidated: [], recomputedRegulations: [] };

  for (const project of ledger.projects) {
    const touchedRegulations = new Set<string>();
    const candidates = ledger.references.filter(
      (ref) => ref.projectId === project.id && ref.status === 'registered' && changedReportIds.includes(ref.reportId)
    );

    for (const ref of candidates) {
      const report = ledger.sharedReports.find((item) => item.id === ref.reportId);
      if (!report) continue; // 丢失来源由链路分析负责，不在此处重算
      const withdrawn = report.status === 'withdrawn';
      if (!withdrawn && ref.reportVersion === report.currentVersion) continue;
      const evidence = project.evidence.find((item) => item.id === ref.evidenceId);
      if (!evidence) continue;
      const affected = ref.configurations.filter((config) => evidence.configurations.includes(config));
      if (!affected.length) continue; // 该引用的配置已失效过，重复同步不重复扣减

      evidence.configurations = evidence.configurations.filter((config) => !affected.includes(config));
      evidence.status = withdrawn ? 'missing' : 'resubmit';
      evidence.note = withdrawn
        ? `共享报告 ${report.id} 已撤回，${affected.join('、')} 配置证据失效，需重新登记来源。`
        : `共享报告 ${report.id} 已换版至 ${report.currentVersion}，${affected.join('、')} 配置证据失效待重交。`;
      evidence.updatedAt = now;
      effects.invalidated.push({
        projectId: project.id,
        evidenceId: evidence.id,
        evidenceName: evidence.name,
        configurations: affected,
        cause: withdrawn ? 'withdrawn' : 'superseded'
      });
      touchedRegulations.add(evidence.regulationId);
    }

    if (!touchedRegulations.size) continue;
    touchedRegulations.forEach((regulationId) => {
      recomputeRegulationCompleteness(ledger, project, regulationId, now);
      effects.recomputedRegulations.push({ projectId: project.id, regulationId });
    });
    const invalidCount = effects.invalidated.filter((item) => item.projectId === project.id).length;
    project.progress = Math.max(10, project.progress - invalidCount * 8);
    project.updatedAt = now;
  }

  return effects;
}

/** 按当前引用账重算单个法规项的覆盖、问题清单和状态，并打上重算时点。 */
function recomputeRegulationCompleteness(
  ledger: LedgerSlice,
  project: ApprovalProject,
  regulationId: string,
  now: string
) {
  const regulation = project.regulations.find((item) => item.id === regulationId);
  if (!regulation) return;
  const linked = project.evidence.filter((item) => item.regulationId === regulationId);
  const refs = ledger.references.filter(
    (ref) => ref.projectId === project.id && ref.status === 'registered' && linked.some((item) => item.id === ref.evidenceId)
  );

  const universe = new Set<string>([project.configuration]);
  linked.forEach((item) => item.configurations.forEach((config) => universe.add(config)));
  refs.forEach((ref) => ref.configurations.forEach((config) => universe.add(config)));

  const validEvidence = linked.filter((item) => ['accepted', 'submitted'].includes(item.status));
  const covered = new Set<string>();
  validEvidence.forEach((item) => item.configurations.forEach((config) => covered.add(config)));
  const uncovered = [...universe].filter((config) => !covered.has(config));

  const issues: string[] = [];
  if (uncovered.length) issues.push(`配置 ${uncovered.join('、')} 缺少有效证据覆盖`);
  refs.forEach((ref) => {
    const report = ledger.sharedReports.find((item) => item.id === ref.reportId);
    if (!report) {
      issues.push(`引用 ${ref.id} 的来源报告 ${ref.reportId} 缺失`);
      return;
    }
    if (report.status === 'withdrawn') {
      issues.push(`共享报告 ${report.id} 已撤回，引用 ${ref.id} 需重新登记来源`);
    } else if (ref.reportVersion !== report.currentVersion) {
      issues.push(`共享报告 ${report.id} 已换版至 ${report.currentVersion}，引用版本 ${ref.reportVersion} 失效`);
    }
  });

  const conflict = validEvidence.some((item) => item.softwareVersion !== project.softwareVersion);
  regulation.coverage = universe.size ? Math.round((covered.size / universe.size) * 100) : 0;
  regulation.issues = issues;
  regulation.status = !validEvidence.length || uncovered.length ? 'missing' : conflict || issues.length ? 'conflict' : 'complete';
  regulation.recomputedAt = now;
}

/** 历史提交包是否已被后续源账变更或证据变动甩开的（只读判断，不回写历史包）。 */
export function isPackageOutdated(
  pkg: SubmissionPackage,
  projects: ApprovalProject[],
  reports: SharedReport[]
): boolean {
  const project = projects.find((item) => item.id === pkg.projectId);
  if (!project) return true;
  const evidenceChanged =
    pkg.evidence.length !== project.evidence.length ||
    pkg.evidence.some((snapshot) => {
      const current = project.evidence.find((item) => item.id === snapshot.id);
      return (
        !current ||
        current.status !== snapshot.status ||
        current.version !== snapshot.version ||
        current.configurations.join('、') !== snapshot.configurations.join('、')
      );
    });
  const referenceStale = pkg.references.some((ref) => {
    const report = reports.find((item) => item.id === ref.reportId);
    return !report || report.status === 'withdrawn' || report.currentVersion !== ref.reportVersion;
  });
  return evidenceChanged || referenceStale;
}
