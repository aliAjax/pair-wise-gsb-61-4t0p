import { defineStore } from 'pinia';
import { seedProjects } from '~/data/seed';
import { seedLedger } from '~/data/seed-ledger';
import {
  applySyncBatch,
  detectChainIssues,
  emptyLedger,
  evaluatePublishGate,
  findReport,
  freezeSubmissionPackage,
  publishReportVersion,
  recompute,
  referenceView,
  referencesForProject,
  registerReference,
  withdrawReportVersion,
  type PublishReportInput
} from '~/services/reference-ledger';
import type {
  ApprovalProject,
  AuditEntry,
  EvidenceItem,
  LedgerState,
  ProjectInput,
  ProjectStatus,
  ProjectVersion,
  PublishGateResult,
  ReferenceChainIssue,
  SyncBatch
} from '~/types/certification';

const STORAGE_KEY = 'vehicle-type-approval-projects-v2';
const LEDGER_STORAGE_KEY = 'vehicle-type-approval-ledger-v1';

function cloneSeed() {
  return structuredClone(seedProjects);
}

function makeId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
}

function audit(actor: string, action: string, detail: string): AuditEntry {
  return {
    id: makeId('AUD'),
    actor,
    action,
    detail,
    createdAt: new Date().toISOString()
  };
}

export interface TransitionResult {
  ok: boolean;
  issues?: string[];
}

export const useCertificationStore = defineStore('certification', {
  state: () => ({
    projects: cloneSeed(),
    ledger: seedLedger() as LedgerState,
    hydrated: false
  }),

  getters: {
    projectById: (state) => (id: string) => state.projects.find((project) => project.id === id),
    agencies: (state) => Array.from(new Set(state.projects.map((project) => project.agency))).sort(),
    expiringEvidence: (state) =>
      state.projects.flatMap((project) =>
        project.evidence
          .filter((item) => item.expiryDate)
          .map((item) => ({ project, evidence: item }))
          .filter(({ evidence }) => new Date(evidence.expiryDate!) <= new Date('2027-01-31'))
      ),
    chainIssues(): ReferenceChainIssue[] {
      return detectChainIssues(this.ledger);
    }
  },

  actions: {
    hydrate() {
      if (this.hydrated || typeof localStorage === 'undefined') return;
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as ApprovalProject[];
          // 兼容旧存档：补齐历史提交包字段
          this.projects = parsed.map((project) => ({ ...project, packages: project.packages ?? [] }));
        }
        const ledgerRaw = localStorage.getItem(LEDGER_STORAGE_KEY);
        this.ledger = ledgerRaw ? ({ ...emptyLedger(), ...(JSON.parse(ledgerRaw) as LedgerState) }) : seedLedger();
      } catch {
        this.projects = cloneSeed();
        this.ledger = seedLedger();
      }
      // 载入后按当前源头账重算一次（幂等：无失效面时不会改动任何证据）
      recompute(this.ledger, this.projects);
      this.hydrated = true;
    },

    persist() {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.projects));
        localStorage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(this.ledger));
      }
    },

    /** 重算并持久化 */
    recalc(projectIds?: string[]) {
      const targets = projectIds
        ? this.projects.filter((project) => projectIds.includes(project.id))
        : this.projects;
      return recompute(this.ledger, targets);
    },

    projectReferences(projectId: string) {
      return referencesForProject(this.ledger, projectId).map((ref) => referenceView(this.ledger, ref));
    },

    publishGate(projectId: string): PublishGateResult | null {
      const project = this.projectById(projectId);
      return project ? evaluatePublishGate(project, this.ledger) : null;
    },

    createProject(input: ProjectInput) {
      const createdAt = new Date().toISOString();
      const project: ApprovalProject = {
        id: `TA-${new Date().getFullYear()}-${String(this.projects.length + 121).padStart(3, '0')}`,
        ...input,
        status: 'draft',
        progress: 18,
        reviewer: '待分派',
        updatedAt: createdAt,
        regulations: [
          {
            id: 'REG-BRAKE',
            code: 'GB 21670',
            title: '乘用车制动系统技术要求',
            category: '安全',
            required: true,
            status: 'missing',
            coverage: 0,
            issues: ['尚未关联测试报告']
          },
          {
            id: 'REG-EMC',
            code: 'GB 34660',
            title: '道路车辆电磁兼容性要求',
            category: '环保',
            required: true,
            status: 'missing',
            coverage: 0,
            issues: ['尚未关联测试报告']
          }
        ],
        evidence: [],
        versions: [
          {
            id: makeId('VER'),
            label: `${input.maintenanceVersion} / ${input.softwareVersion}`,
            author: input.applicant,
            createdAt,
            summary: '创建认证证据包草稿。',
            changes: ['录入车型、配置和维护版本', '建立基础法规项'],
            impactedConfigurations: [input.configuration]
          }
        ],
        audit: [audit(input.applicant, '建立项目', '创建型式认证证据包草稿。')],
        packages: []
      };
      this.projects.unshift(project);
      this.persist();
      return project.id;
    },

    updateProject(id: string, input: ProjectInput, reason: string) {
      const project = this.projects.find((item) => item.id === id);
      if (!project) return false;
      const previous = {
        maintenanceVersion: project.maintenanceVersion,
        softwareVersion: project.softwareVersion,
        configuration: project.configuration
      };
      Object.assign(project, input, { updatedAt: new Date().toISOString() });

      const changed: string[] = [];
      if (previous.maintenanceVersion !== input.maintenanceVersion) changed.push('维护版本');
      if (previous.softwareVersion !== input.softwareVersion) changed.push('软件版本');
      if (previous.configuration !== input.configuration) changed.push('配置范围');

      if (changed.length) {
        const version: ProjectVersion = {
          id: makeId('VER'),
          label: `${input.maintenanceVersion} / ${input.softwareVersion}`,
          author: project.applicant,
          createdAt: new Date().toISOString(),
          summary: `更新${changed.join('、')}：${reason}`,
          changes: changed,
          impactedConfigurations: [input.configuration]
        };
        project.versions.unshift(version);
        project.audit.unshift(
          audit(project.applicant, '更新项目版本', `${changed.join('、')}；影响配置：${input.configuration}`)
        );
      } else {
        project.audit.unshift(audit(project.applicant, '更新项目资料', reason));
      }
      this.recalc([id]);
      this.persist();
      return true;
    },

    transition(id: string, status: ProjectStatus, actor: string, reason: string): TransitionResult {
      const project = this.projects.find((item) => item.id === id);
      if (!project) return { ok: false, issues: ['项目不存在'] };

      // 引用成环 / 丢失来源：列出链路并停住发布（提交与批准都拦）
      const gate = evaluatePublishGate(project, this.ledger);
      const blockingChains = gate.chainIssues;
      if ((status === 'submitted' || status === 'approved') && blockingChains.length) {
        return {
          ok: false,
          issues: blockingChains.map((item) => (item.type === 'cycle' ? '引用成环：' : '来源丢失：') + item.detail)
        };
      }
      if (status === 'approved' && !gate.allowed) {
        return { ok: false, issues: gate.issues };
      }

      project.status = status;
      if (status === 'submitted') project.submittedAt = new Date().toISOString().slice(0, 10);
      if (status === 'approved') project.progress = 100;
      if (status === 'supplement_required') project.progress = Math.min(project.progress, 82);
      project.updatedAt = new Date().toISOString();
      project.audit.unshift(audit(actor, '审批状态流转', `${status}；${reason}`));
      this.persist();
      return { ok: true };
    },

    updateEvidence(projectId: string, evidenceId: string, status: EvidenceItem['status'], note: string) {
      const project = this.projects.find((item) => item.id === projectId);
      const evidence = project?.evidence.find((item) => item.id === evidenceId);
      if (!project || !evidence) return false;
      evidence.status = status;
      evidence.note = note || evidence.note;
      evidence.updatedAt = new Date().toISOString();
      if (status === 'accepted') evidence.invalidatedConfigurations = [];
      project.updatedAt = evidence.updatedAt;
      project.audit.unshift(audit(project.reviewer, '更新证据状态', `${evidence.name}：${status}`));
      this.recalc([projectId]);
      this.persist();
      return true;
    },

    bulkSupplement(projectId: string, evidenceIds: string[], note: string) {
      const project = this.projects.find((item) => item.id === projectId);
      if (!project) return 0;
      let count = 0;
      project.evidence.forEach((evidence) => {
        if (!evidenceIds.includes(evidence.id)) return;
        evidence.status = 'submitted';
        evidence.softwareVersion = project.softwareVersion;
        evidence.note = note;
        evidence.updatedAt = new Date().toISOString();
        count += 1;
      });
      if (count) {
        project.progress = Math.min(95, project.progress + count * 4);
        project.updatedAt = new Date().toISOString();
        project.audit.unshift(audit(project.applicant, '批量补件', `${count} 项证据更新至 ${project.softwareVersion}。${note}`));
        this.recalc([projectId]);
        this.persist();
      }
      return count;
    },

    /* ----------------------- 共享报告引用账操作 ----------------------- */

    /**
     * 发布源头报告新版本：旧版换版后，只让受影响配置的证据失效重算，
     * 其他项目/配置继续有效。
     */
    publishSharedReport(input: PublishReportInput, actor: string) {
      const newId = publishReportVersion(this.ledger, input);
      const changes = this.recalc();
      this.writeLedgerAudit(changes, actor, '源头报告换版', `发布 ${input.familyName} ${input.version}`);
      this.persist();
      return newId;
    },

    /** 撤回源头报告版本 */
    withdrawSharedReport(versionId: string, reason: string, actor: string) {
      const report = findReport(this.ledger.reports, versionId);
      if (!report) return false;
      withdrawReportVersion(this.ledger, versionId, reason);
      const changes = this.recalc();
      this.writeLedgerAudit(changes, actor, '源头报告撤回', `${report.familyName} ${report.version}：${reason}`);
      this.persist();
      return true;
    },

    /**
     * 项目登记 / 刷新共享引用。重新登记到新版本后，受影响配置证据恢复。
     * 新引用自动建立关联证据条目。
     */
    registerProjectReference(
      projectId: string,
      payload: { regulationId: string; reportVersionId: string; configurations: string[] },
      actor: string
    ) {
      const project = this.projectById(projectId);
      if (!project) throw new Error('项目不存在');
      const ref = registerReference(this.ledger, { projectId, ...payload });
      const linked = project.evidence.find((evidence) => evidence.reportRefId === ref.id);
      if (!linked) {
        const report = findReport(this.ledger.reports, payload.reportVersionId)!;
        project.evidence.push({
          id: makeId('EV'),
          projectId,
          regulationId: payload.regulationId,
          name: `${report.familyName}（共用）`,
          type: 'test_report',
          version: report.version,
          softwareVersion: project.softwareVersion,
          configurations: [...payload.configurations],
          status: 'submitted',
          reportRefId: ref.id,
          note: `登记共享报告引用 ${report.familyName} ${report.version}，覆盖 ${payload.configurations.join('、')}。`,
          updatedAt: new Date().toISOString()
        });
      } else {
        const report = findReport(this.ledger.reports, payload.reportVersionId)!;
        linked.version = report.version;
        linked.configurations = [...payload.configurations];
      }
      const changes = this.recalc([projectId]);
      project.audit.unshift(
        audit(
          actor,
          '登记共享引用',
          `引用 ${findReport(this.ledger.reports, payload.reportVersionId)!.familyName} ${findReport(this.ledger.reports, payload.reportVersionId)!.version}，覆盖配置 ${payload.configurations.join('、')}`
        )
      );
      this.writeLedgerAudit(changes, actor, '引用登记', `项目 ${projectId} 引用刷新`);
      this.persist();
      return ref.id;
    },

    /** 源账整批同步：失败时保留完整批次以便恢复重试；重复同步幂等不回退 */
    syncSourceBatch(
      input: { note: string; references: Array<{ projectId: string; regulationId: string; reportVersionId: string; configurations: string[] }> },
      options: { batchId?: string; simulateFailure?: boolean } = {}
    ) {
      const result = applySyncBatch(this.ledger, this.projects, input, options);
      if (result.applied && !result.alreadyApplied) {
        // 为新登记但尚无关联证据的引用补建证据条目
        for (const item of input.references) {
          const project = this.projectById(item.projectId);
          const report = findReport(this.ledger.reports, item.reportVersionId);
          if (!project || !report) continue;
          const ref = this.ledger.references.find(
            (candidate) =>
              candidate.projectId === item.projectId &&
              candidate.regulationId === item.regulationId &&
              candidate.reportKey === report.reportKey
          );
          if (!ref) continue;
          if (!project.evidence.some((evidence) => evidence.reportRefId === ref.id)) {
            project.evidence.push({
              id: makeId('EV'),
              projectId: item.projectId,
              regulationId: item.regulationId,
              name: `${report.familyName}（共用）`,
              type: 'test_report',
              version: report.version,
              softwareVersion: project.softwareVersion,
              configurations: [...item.configurations],
              status: 'submitted',
              reportRefId: ref.id,
              note: `源账批次同步登记：${report.familyName} ${report.version}。`,
              updatedAt: new Date().toISOString()
            });
          }
        }
        this.recalc();
        for (const item of input.references) {
          const project = this.projectById(item.projectId);
          const report = findReport(this.ledger.reports, item.reportVersionId);
          project?.audit.unshift(
            audit(
              '源账同步服务',
              '源账批次同步',
              `${result.batchId}：${report?.familyName ?? ''} ${report?.version ?? ''} 覆盖 ${item.configurations.join('、')}`
            )
          );
        }
      }
      this.persist();
      return result;
    },

    /** 从保留的完整批次恢复重试 */
    retryBatch(batchId: string, simulateFailure = false) {
      const batch = this.ledger.batches.find((item) => item.id === batchId);
      if (!batch) return null;
      if (batch.applied) {
        return applySyncBatch(this.ledger, this.projects, { note: batch.note, references: [] }, { batchId });
      }
      const input = {
        note: batch.note,
        references: batch.references.map((item) => ({
          projectId: item.projectId,
          regulationId: item.regulationId,
          reportVersionId: item.reportVersionId,
          configurations: [...item.configurations]
        }))
      };
      const result = applySyncBatch(this.ledger, this.projects, input, { batchId, simulateFailure });
      if (result.applied) {
        this.recalc();
        for (const item of input.references) {
          this.projectById(item.projectId)?.audit.unshift(
            audit('源账同步服务', '批次恢复重试', `${batchId} 恢复成功并应用完整引用批次。`)
          );
        }
      }
      this.persist();
      return result;
    },

    pendingBatches(): SyncBatch[] {
      return this.ledger.batches.filter((batch) => !batch.applied);
    },

    /** 冻结历史提交包：按冻结时间点保存，之后源头换版不回改 */
    freezePackage(projectId: string, label: string, note: string, actor: string) {
      const project = this.projectById(projectId);
      if (!project) return null;
      const frozen = freezeSubmissionPackage(project, this.ledger, { label, author: actor, note });
      project.packages.push(frozen);
      project.audit.unshift(audit(actor, '冻结提交包', `${label}：${note}`));
      this.persist();
      return frozen;
    },

    /** 注入链路问题场景（成环 / 丢失来源），供发布闸门演示与校验；均可 clear 复原 */
    injectChainScenario(kind: 'cycle' | 'missing_source' | 'clear') {
      if (kind === 'clear') {
        this.ledger.reports.forEach((report) => {
          // 剔除自环与悬空依赖
          report.dependsOn = report.dependsOn.filter((dep) => dep !== report.id && findReport(this.ledger.reports, dep));
        });
        this.ledger.references = this.ledger.references.filter((ref) => ref.id !== 'RR-GHOST');
      } else if (kind === 'cycle') {
        const active = this.ledger.reports.find((report) => report.status === 'active');
        if (active && !active.dependsOn.includes(active.id)) active.dependsOn.push(active.id);
      } else {
        if (!this.ledger.references.some((ref) => ref.id === 'RR-GHOST')) {
          this.ledger.references.push({
            id: 'RR-GHOST',
            projectId: this.projects[0]?.id ?? 'TA-2026-118',
            regulationId: 'REG-BATTERY',
            reportVersionId: 'SR-MISSING-GHOST',
            reportKey: 'KEY-GHOST',
            configurations: ['幻影配置'],
            registeredAt: new Date().toISOString(),
            invalidatedConfigurations: ['幻影配置']
          });
        }
      }
      this.recalc();
      this.persist();
    },

    reset() {
      this.projects = cloneSeed();
      this.ledger = seedLedger();
      this.persist();
    },

    writeLedgerAudit(
      changes: ReturnType<typeof recompute>,
      actor: string,
      action: string,
      prefix: string
    ) {
      for (const change of changes) {
        const project = this.projectById(change.projectId);
        if (!project) continue;
        const invalid = change.invalidatedEvidence
          .map((item) => `${this.evidenceName(project, item.evidenceId)}（配置 ${item.configs.join('、')} 失效）`)
          .join('；');
        const restored = change.restoredEvidence.map((id) => this.evidenceName(project, id)).join('、');
        const details = [invalid && `失效重算：${invalid}`, restored && `恢复有效：${restored}`].filter(Boolean);
        if (!details.length) continue;
        project.audit.unshift(audit(actor, action, `${prefix}；${details.join('；')}。`));
        project.updatedAt = new Date().toISOString();
      }
    },

    evidenceName(project: ApprovalProject, evidenceId: string) {
      return project.evidence.find((item) => item.id === evidenceId)?.name ?? evidenceId;
    }
  }
});
