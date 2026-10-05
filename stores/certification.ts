import { defineStore } from 'pinia';
import { seedProjects, seedReferences, seedSharedReports } from '~/data/seed';
import {
  analyzeReferenceChains,
  applyBatchItem,
  recomputeSharedReferences,
  type RecomputeEffects
} from '~/services/reference-ledger';
import type {
  ApprovalProject,
  AuditEntry,
  EvidenceItem,
  ProjectInput,
  ProjectStatus,
  ProjectVersion,
  ReportReference,
  SharedReport,
  SubmissionPackage,
  SyncBatch,
  SyncCheckpoint,
  SyncFailure,
  SyncLogEntry
} from '~/types/certification';

const STORAGE_KEY = 'vehicle-type-approval-projects-v1';
const LEDGER_KEY = 'vehicle-type-approval-shared-ledger-v1';

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

function syncLogEntry(batch: SyncBatch, kind: SyncLogEntry['kind'], detail: string): SyncLogEntry {
  return {
    id: makeId('SYNC'),
    batchId: batch.id,
    label: batch.label,
    kind,
    detail,
    createdAt: new Date().toISOString()
  };
}

export interface SyncResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
  effects?: RecomputeEffects;
}

export interface ReferenceInput {
  evidenceId: string;
  reportId: string;
  reportVersion: string;
  configurations: string[];
  derivedFrom?: string;
}

export const useCertificationStore = defineStore('certification', {
  state: () => ({
    projects: cloneSeed(),
    sharedReports: structuredClone(seedSharedReports) as SharedReport[],
    references: structuredClone(seedReferences) as ReportReference[],
    packages: [] as SubmissionPackage[],
    syncLog: [] as SyncLogEntry[],
    syncCheckpoint: null as SyncCheckpoint | null,
    pendingSyncFailure: null as SyncFailure | null,
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
    referencesByProject: (state) => (projectId: string) =>
      state.references.filter((ref) => ref.projectId === projectId),
    sharedReportById: (state) => (id: string) => state.sharedReports.find((report) => report.id === id),
    /** 引用成环或丢失来源的项目级发布阻断，链路原样列出。 */
    publicationHolds: (state) => (projectId: string) =>
      analyzeReferenceChains(state.references, state.sharedReports, projectId)
  },

  actions: {
    hydrate() {
      if (this.hydrated || typeof localStorage === 'undefined') return;
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) this.projects = JSON.parse(raw) as ApprovalProject[];
      } catch {
        this.projects = cloneSeed();
      }
      try {
        const rawLedger = localStorage.getItem(LEDGER_KEY);
        if (rawLedger) {
          const ledger = JSON.parse(rawLedger) as Partial<{
            sharedReports: SharedReport[];
            references: ReportReference[];
            packages: SubmissionPackage[];
            syncLog: SyncLogEntry[];
            syncCheckpoint: SyncCheckpoint | null;
            pendingSyncFailure: SyncFailure | null;
          }>;
          if (ledger.sharedReports) this.sharedReports = ledger.sharedReports;
          if (ledger.references) this.references = ledger.references;
          if (ledger.packages) this.packages = ledger.packages;
          if (ledger.syncLog) this.syncLog = ledger.syncLog;
          if (ledger.syncCheckpoint) this.syncCheckpoint = ledger.syncCheckpoint;
          if (ledger.pendingSyncFailure) this.pendingSyncFailure = ledger.pendingSyncFailure;
        }
      } catch {
        this.sharedReports = structuredClone(seedSharedReports);
        this.references = structuredClone(seedReferences);
      }
      this.hydrated = true;
    },

    persist() {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.projects));
      localStorage.setItem(
        LEDGER_KEY,
        JSON.stringify({
          sharedReports: this.sharedReports,
          references: this.references,
          packages: this.packages,
          syncLog: this.syncLog,
          syncCheckpoint: this.syncCheckpoint,
          pendingSyncFailure: this.pendingSyncFailure
        })
      );
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
        audit: [audit(input.applicant, '建立项目', '创建型式认证证据包草稿。')]
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
      this.persist();
      return true;
    },

    transition(id: string, status: ProjectStatus, actor: string, reason: string) {
      const project = this.projects.find((item) => item.id === id);
      if (!project) return false;
      if (['submitted', 'approved'].includes(status)) {
        const holds = analyzeReferenceChains(this.references, this.sharedReports, id);
        if (holds.length) {
          project.audit.unshift(
            audit(actor, '发布被停住', `目标状态 ${status} 被阻断：${holds.map((hold) => hold.chain.join(' → ')).join('；')}`)
          );
          project.updatedAt = new Date().toISOString();
          this.persist();
          return false;
        }
      }
      project.status = status;
      if (status === 'submitted') project.submittedAt = new Date().toISOString().slice(0, 10);
      if (status === 'approved') project.progress = 100;
      if (status === 'supplement_required') project.progress = Math.min(project.progress, 82);
      project.updatedAt = new Date().toISOString();
      project.audit.unshift(audit(actor, '审批状态流转', `${status}；${reason}`));
      // 提交/批准时点各冻结一份历史提交包，后续源账变更不回写。
      if (status === 'submitted') this.snapshotPackage(id, 'submit');
      if (status === 'approved') this.snapshotPackage(id, 'approve');
      this.persist();
      return true;
    },

    updateEvidence(projectId: string, evidenceId: string, status: EvidenceItem['status'], note: string) {
      const project = this.projects.find((item) => item.id === projectId);
      const evidence = project?.evidence.find((item) => item.id === evidenceId);
      if (!project || !evidence) return false;
      evidence.status = status;
      evidence.note = note || evidence.note;
      evidence.updatedAt = new Date().toISOString();
      project.updatedAt = evidence.updatedAt;
      project.audit.unshift(audit(project.reviewer, '更新证据状态', `${evidence.name}：${status}`));
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
        this.persist();
      }
      return count;
    },

    /** 项目登记引用的共享报告版本与覆盖配置。 */
    registerReference(projectId: string, input: ReferenceInput): { ok: boolean; id?: string; error?: string } {
      const project = this.projects.find((item) => item.id === projectId);
      if (!project) return { ok: false, error: '认证项目不存在' };
      const evidence = project.evidence.find((item) => item.id === input.evidenceId);
      if (!evidence) return { ok: false, error: '所选证据不属于当前项目' };
      const report = this.sharedReports.find((item) => item.id === input.reportId);
      if (!report) return { ok: false, error: '来源报告不在共享源账中' };
      if (!report.versions.some((version) => version.version === input.reportVersion)) {
        return { ok: false, error: `来源报告 ${report.id} 没有版本 ${input.reportVersion}` };
      }
      if (!input.configurations.length) return { ok: false, error: '至少选择一个覆盖配置' };
      if (input.derivedFrom) {
        const upstream = this.references.find((ref) => ref.id === input.derivedFrom && ref.status === 'registered');
        if (!upstream) return { ok: false, error: '上游引用不存在或已注销' };
        if (upstream.projectId === projectId) return { ok: false, error: '上游引用应来自其他项目的登记' };
      }
      const reference: ReportReference = {
        id: makeId('REF'),
        projectId,
        evidenceId: input.evidenceId,
        reportId: input.reportId,
        reportVersion: input.reportVersion,
        configurations: [...input.configurations],
        derivedFrom: input.derivedFrom,
        registeredAt: new Date().toISOString(),
        status: 'registered'
      };
      this.references.push(reference);
      project.audit.unshift(
        audit(
          project.applicant,
          '登记共享报告引用',
          `${reference.id}：${report.id}@${input.reportVersion}，覆盖 ${input.configurations.join('、')}${
            input.derivedFrom ? `，上游 ${input.derivedFrom}` : ''
          }`
        )
      );
      this.persist();
      return { ok: true, id: reference.id };
    },

    /** 注销异常引用（成环节点、丢失来源等），解除发布阻断。 */
    deregisterReference(refId: string, reason: string) {
      const reference = this.references.find((ref) => ref.id === refId);
      if (!reference || reference.status !== 'registered') return false;
      reference.status = 'deregistered';
      reference.deregisterReason = reason;
      const project = this.projects.find((item) => item.id === reference.projectId);
      project?.audit.unshift(audit('认证机构审阅人', '注销共享引用', `${refId}：${reason}`));
      this.persist();
      return true;
    },

    /**
     * 应用源账同步批次。已完整应用的批次直接跳过（重复同步不反复回退）；
     * 应用前记录完整批次恢复点，通道中断时保留部分应用状态并登记待恢复失败。
     */
    applySourceBatch(batch: SyncBatch, options?: { simulateFailure?: boolean }): SyncResult {
      const now = new Date().toISOString();
      if (this.syncLog.some((entry) => entry.batchId === batch.id && entry.kind === 'applied')) {
        this.syncLog.unshift(syncLogEntry(batch, 'skipped', '批次此前已完整应用，重复同步被忽略，未发生回退。'));
        this.persist();
        return { ok: true, skipped: true };
      }
      if (this.pendingSyncFailure) {
        return { ok: false, error: `批次 ${this.pendingSyncFailure.batchId} 尚未恢复，请先从完整引用批次恢复重试。` };
      }
      const invalid = batch.items.filter((item) => {
        const report = this.sharedReports.find((entry) => entry.id === item.reportId);
        return !report || (item.action === 'update' && !item.version);
      });
      if (invalid.length) {
        this.syncLog.unshift(
          syncLogEntry(batch, 'failed', `批次校验失败：${invalid.map((item) => item.reportId).join('、')} 未通过校验，未做任何变更。`)
        );
        this.persist();
        return { ok: false, error: '批次校验失败，未应用任何变更。' };
      }

      // 恢复点：上一个完整批次（或初始完整账）时刻的账快照。
      const lastComplete = this.syncLog.find((entry) => entry.kind === 'applied')?.batchId ?? 'SEED';
      this.syncCheckpoint = {
        batchId: lastComplete,
        sharedReports: structuredClone(this.sharedReports),
        projects: structuredClone(this.projects)
      };

      const applied: string[] = [];
      for (const [index, item] of batch.items.entries()) {
        if (options?.simulateFailure && index === 1) {
          this.pendingSyncFailure = {
            batchId: batch.id,
            label: batch.label,
            reason: '源账通道中断，批次仅部分应用。',
            failedAt: now,
            recovered: false,
            batch: structuredClone(batch)
          };
          this.syncLog.unshift(
            syncLogEntry(batch, 'failed', `应用 ${applied.join('、')} 后通道中断，剩余 ${batch.items.length - applied.length} 项未应用。`)
          );
          this.persist();
          return { ok: false, error: '源账同步中断，批次部分应用，请从完整引用批次恢复重试。' };
        }
        applyBatchItem(this.sharedReports, item, now);
        applied.push(item.reportId);
      }

      const effects = recomputeSharedReferences(this, batch.items.map((item) => item.reportId), now);
      this.auditRecompute(batch.id, effects);
      this.syncLog.unshift(
        syncLogEntry(
          batch,
          'applied',
          `应用 ${applied.length} 项源账变更；${effects.invalidated.length} 项证据失效，${effects.recomputedRegulations.length} 项法规完整性重算。`
        )
      );
      this.persist();
      return { ok: true, effects };
    },

    /**
     * 源账同步失败后的恢复重试：先回退到完整引用批次恢复点（每次失败仅回退一次，
     * 重复恢复只重试应用、不反复回退），再重放整个失败批次。
     */
    recoverFailedSync(): SyncResult {
      const failure = this.pendingSyncFailure;
      if (!failure) return { ok: false, error: '当前没有待恢复的同步失败。' };
      const now = new Date().toISOString();
      const checkpointId = this.syncCheckpoint?.batchId ?? 'SEED';

      if (!failure.recovered) {
        if (this.syncCheckpoint) {
          this.sharedReports = structuredClone(this.syncCheckpoint.sharedReports);
          this.projects = structuredClone(this.syncCheckpoint.projects);
        }
        failure.recovered = true;
        this.syncLog.unshift(
          syncLogEntry(failure.batch, 'recovered', `已回退到完整批次 ${checkpointId} 的引用账状态，开始重试 ${failure.batchId}。`)
        );
      } else {
        this.syncLog.unshift(
          syncLogEntry(failure.batch, 'recovered', `批次 ${failure.batchId} 已完成回退，本次仅重试应用，不重复回退。`)
        );
      }

      const batch = failure.batch;
      batch.items.forEach((item) => applyBatchItem(this.sharedReports, item, now));
      const effects = recomputeSharedReferences(this, batch.items.map((item) => item.reportId), now);
      this.auditRecompute(batch.id, effects, checkpointId);
      this.pendingSyncFailure = null;
      this.syncLog.unshift(
        syncLogEntry(
          batch,
          'applied',
          `恢复重试成功，应用 ${batch.items.length} 项；${effects.invalidated.length} 项证据失效，${effects.recomputedRegulations.length} 项法规完整性重算。`
        )
      );
      this.persist();
      return { ok: true, effects };
    },

    /** 失效重算结果写入各项目审计流。 */
    auditRecompute(batchId: string, effects: RecomputeEffects, restoredFrom?: string) {
      const byProject = new Map<string, RecomputeEffects['invalidated']>();
      effects.invalidated.forEach((item) => {
        const list = byProject.get(item.projectId) ?? [];
        list.push(item);
        byProject.set(item.projectId, list);
      });
      byProject.forEach((items, projectId) => {
        const project = this.projects.find((entry) => entry.id === projectId);
        if (!project) return;
        const detail = items
          .map((item) => `${item.evidenceName}（${item.configurations.join('、')}）${item.cause === 'withdrawn' ? '源已撤回' : '源已换版'}`)
          .join('；');
        project.audit.unshift(
          audit(
            '源账同步',
            restoredFrom ? '失败批次恢复重试' : '共享报告失效重算',
            `批次 ${batchId}：${detail}，法规完整性已按当前时点重算。${restoredFrom ? `恢复点 ${restoredFrom}。` : ''}`
          )
        );
      });
    },

    /** 在各自时点冻结提交包快照（提交/批准/导出），历史包不被后续源账变更回写。 */
    snapshotPackage(projectId: string, reason: SubmissionPackage['reason']) {
      const project = this.projects.find((item) => item.id === projectId);
      if (!project) return null;
      const pkg: SubmissionPackage = {
        id: makeId('PKG'),
        projectId,
        reason,
        createdAt: new Date().toISOString(),
        evidence: project.evidence.map((item) => ({
          id: item.id,
          name: item.name,
          version: item.version,
          status: item.status,
          configurations: [...item.configurations]
        })),
        references: this.references
          .filter((ref) => ref.projectId === projectId && ref.status === 'registered')
          .map((ref) => ({
            id: ref.id,
            reportId: ref.reportId,
            reportVersion: ref.reportVersion,
            configurations: [...ref.configurations]
          }))
      };
      this.packages.unshift(pkg);
      return pkg;
    },

    exportPackages(projectIds: string[]) {
      projectIds.forEach((id) => this.snapshotPackage(id, 'export'));
      this.persist();
    },

    reset() {
      this.projects = cloneSeed();
      this.sharedReports = structuredClone(seedSharedReports);
      this.references = structuredClone(seedReferences);
      this.packages = [];
      this.syncLog = [];
      this.syncCheckpoint = null;
      this.pendingSyncFailure = null;
      this.persist();
    }
  }
});
