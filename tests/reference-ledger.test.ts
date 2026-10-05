/**
 * 共享报告引用账纯逻辑场景验证（可用 jiti 直接运行 TS）：
 *   npx jiti tests/reference-ledger.test.ts
 */
import {
  applySyncBatch,
  detectChainIssues,
  emptyLedger,
  evaluatePublishGate,
  findReport,
  freezeSubmissionPackage,
  publishReportVersion,
  recompute,
  referenceHealth,
  referencesForProject,
  registerReference,
  withdrawReportVersion,
  type PublishReportInput
} from '../services/reference-ledger';
import type { ApprovalProject, LedgerState, SharedReportVersion } from '../types/certification';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function deepEqual(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/* ---------------------------- 测试夹具 ---------------------------- */

const BAT_KEY = 'KEY-BAT-PACK-A';
const configsA = ['长续航四驱版', '标准续航后驱版'];
const configsB = ['标准厢式版'];

function makeReport(id: string, version: string, status: SharedReportVersion['status'], configurations: string[], extra: Partial<SharedReportVersion> = {}): SharedReportVersion {
  return {
    id,
    reportKey: BAT_KEY,
    familyName: '动力电池包安全测试报告',
    regulationId: 'REG-BATTERY',
    version,
    configurations,
    status,
    dependsOn: [],
    publishedAt: '2026-09-01T00:00:00.000Z',
    note: '',
    ...extra
  };
}

function makeProject(id: string, configuration: string, refId: string | undefined, evidenceVersion: string) {
  const configs = id === 'TA-A' ? configsA : configsB;
  const project = {
    id,
    name: id,
    modelCode: 'M',
    vehicleType: 'M1',
    configuration,
    maintenanceVersion: 'MY27.0',
    softwareVersion: '8.4.1',
    status: 'draft' as const,
    progress: 50,
    applicant: '申请人',
    reviewer: '审阅人',
    agency: '机构',
    updatedAt: '2026-09-01T00:00:00.000Z',
    certificateExpiry: '2028-01-01',
    regulations: [
      {
        id: 'REG-BATTERY',
        code: 'GB 38031',
        title: '电池安全',
        category: '安全' as const,
        required: true,
        status: 'complete' as const,
        coverage: 100,
        issues: []
      }
    ],
    evidence: [
      {
        id: `EV-${id}`,
        projectId: id,
        regulationId: 'REG-BATTERY',
        name: '动力电池包安全测试报告',
        type: 'test_report' as const,
        version: evidenceVersion,
        softwareVersion: '8.4.1',
        configurations: configs,
        status: 'accepted' as const,
        reportRefId: refId,
        note: '',
        updatedAt: '2026-09-01T00:00:00.000Z'
      }
    ],
    versions: [],
    audit: [],
    packages: []
  } satisfies ApprovalProject;
  return project;
}

function freshFixture(): { ledger: LedgerState; projectA: ApprovalProject; projectB: ApprovalProject } {
  const ledger = emptyLedger();
  const r4 = makeReport('SR-R4', 'R4', 'active', [...configsA, ...configsB]);
  ledger.reports.push(r4);
  const projectA = makeProject('TA-A', '长续航四驱版', 'RR-A', 'R4');
  const projectB = makeProject('TA-B', '标准厢式版', 'RR-B', 'R4');
  registerReference(
    ledger,
    { projectId: 'TA-A', regulationId: 'REG-BATTERY', reportVersionId: 'SR-R4', configurations: configsA },
    '2026-09-02T00:00:00.000Z'
  );
  // registerReference 会生成随机 RR id，把证据挂到刚登记的引用上
  const refA = ledger.references.find((ref) => ref.projectId === 'TA-A')!;
  projectA.evidence[0].reportRefId = refA.id;
  registerReference(
    ledger,
    { projectId: 'TA-B', regulationId: 'REG-BATTERY', reportVersionId: 'SR-R4', configurations: configsB },
    '2026-09-02T00:00:00.000Z'
  );
  const refB = ledger.references.find((ref) => ref.projectId === 'TA-B')!;
  projectB.evidence[0].reportRefId = refB.id;
  recompute(ledger, [projectA, projectB], '2026-09-03T00:00:00.000Z');
  return { ledger, projectA, projectB };
}

console.log('场景 1：多车型共用同一份报告，初始均有效');
{
  const { ledger, projectA, projectB } = freshFixture();
  check('两个项目各有一条引用', ledger.references.length === 2);
  check('项目 A 证据 accepted', projectA.evidence[0].status === 'accepted');
  check('项目 B 证据 accepted', projectB.evidence[0].status === 'accepted');
  check('电池法规 A 完整', projectA.regulations[0].status === 'complete', projectA.regulations[0].issues.join('|'));
  check('电池法规 B 完整', projectB.regulations[0].status === 'complete', projectB.regulations[0].issues.join('|'));
}

console.log('场景 2：源头换版 R5 仅覆盖部分配置，只让受影响配置失效');
{
  const { ledger, projectA, projectB } = freshFixture();
  // R5 只覆盖 A 的两个配置，不再覆盖 B 的标准厢式版
  publishReportVersion(
    ledger,
    {
      reportKey: BAT_KEY,
      familyName: '动力电池包安全测试报告',
      regulationId: 'REG-BATTERY',
      version: 'R5',
      configurations: configsA,
      note: '换版'
    } satisfies PublishReportInput,
    '2026-10-01T00:00:00.000Z'
  );
  recompute(ledger, [projectA, projectB], '2026-10-01T01:00:00.000Z');

  const refA = referencesForProject(ledger, 'TA-A')[0];
  const refB = referencesForProject(ledger, 'TA-B')[0];
  const healthA = referenceHealth(refA, ledger.reports);
  const healthB = referenceHealth(refB, ledger.reports);

  check('A 引用旧版 superseded', healthA.status === 'superseded');
  check('A 两配置标记失效（等项目重新登记）', deepEqual(refA.invalidatedConfigurations.sort(), [...configsA].sort()));
  check('A 两配置在新版中可恢复', deepEqual(healthA.refreshable.sort(), [...configsA].sort()));
  check('A 证据转为 resubmit', projectA.evidence[0].status === 'resubmit');
  check('A 失效配置为两配置', deepEqual((projectA.evidence[0].invalidatedConfigurations ?? []).sort(), [...configsA].sort()));

  check('B 同样挂在旧版（共用源头）', healthB.status === 'superseded');
  check('B 标准厢式版在 R5 中不再覆盖（不可恢复）', healthB.refreshable.length === 0);
  check('B 证据失效', projectB.evidence[0].status === 'resubmit');
  check('B 法规完整性为 conflict', projectB.regulations[0].status === 'conflict');
}

console.log('场景 3：项目 A 重新登记 R5 后恢复；项目 B 仍失效（其他项目不受恢复影响）');
{
  const { ledger, projectA, projectB } = freshFixture();
  publishReportVersion(
    ledger,
    { reportKey: BAT_KEY, familyName: '动力电池包安全测试报告', regulationId: 'REG-BATTERY', version: 'R5', configurations: configsA },
    '2026-10-01T00:00:00.000Z'
  );
  recompute(ledger, [projectA, projectB], '2026-10-01T01:00:00.000Z');

  const refA = referencesForProject(ledger, 'TA-A')[0];
  registerReference(
    ledger,
    { projectId: 'TA-A', regulationId: 'REG-BATTERY', reportVersionId: findReport(ledger.reports, 'SR-R4') ? ledger.reports.find((r) => r.version === 'R5')!.id : '', configurations: configsA },
    '2026-10-02T00:00:00.000Z'
  );
  void refA;
  recompute(ledger, [projectA, projectB], '2026-10-02T01:00:00.000Z');

  check('A 引用指向 R5', referencesForProject(ledger, 'TA-A')[0].reportVersionId === ledger.reports.find((r) => r.version === 'R5')!.id);
  check('A 引用无失效配置', referencesForProject(ledger, 'TA-A')[0].invalidatedConfigurations.length === 0);
  check('A 证据恢复为 submitted', projectA.evidence[0].status === 'submitted');
  check('A 失效配置已清空', (projectA.evidence[0].invalidatedConfigurations ?? []).length === 0);
  // 审阅人接受后重新完整
  projectA.evidence[0].status = 'accepted';
  recompute(ledger, [projectA], '2026-10-02T02:00:00.000Z');
  check('A 接受后法规恢复 complete', projectA.regulations[0].status === 'complete', projectA.regulations[0].issues.join('|'));
  check('B 仍然失效（恢复不波及其他项目）', projectB.evidence[0].status === 'resubmit');
  check('B 法规仍为 conflict', projectB.regulations[0].status === 'conflict');
}

console.log('场景 4：源头撤回 → 全部引用配置失效，且不可“换版刷新”');
{
  const { ledger, projectA, projectB } = freshFixture();
  withdrawReportVersion(ledger, 'SR-R4', '试验条件异常撤回', '2026-10-03T00:00:00.000Z');
  recompute(ledger, [projectA, projectB], '2026-10-03T01:00:00.000Z');
  const healthA = referenceHealth(referencesForProject(ledger, 'TA-A')[0], ledger.reports);
  check('引用健康状态 withdrawn', healthA.status === 'withdrawn');
  check('A 证据 resubmit', projectA.evidence[0].status === 'resubmit');
  check('B 证据 resubmit', projectB.evidence[0].status === 'resubmit');
  check('审批闸门禁止发布', !evaluatePublishGate(projectA, ledger).allowed);
}

console.log('场景 5：超登记配置（项目登记了源头未覆盖的配置）');
{
  const { ledger, projectA } = freshFixture();
  const refA = referencesForProject(ledger, 'TA-A')[0];
  refA.configurations = [...configsA, '幽灵性能版'];
  projectA.evidence[0].configurations = [...configsA, '幽灵性能版'];
  recompute(ledger, [projectA], '2026-10-04T00:00:00.000Z');
  check('超登记配置被识别为失效', refA.invalidatedConfigurations.includes('幽灵性能版'));
  check('仅幽灵配置失效，其他仍有效', (projectA.evidence[0].invalidatedConfigurations ?? []).join() === '幽灵性能版');
  check('法规 conflict 且覆盖率非 100', projectA.regulations[0].coverage < 100);
}

console.log('场景 6：源账同步失败 → 完整批次保留；恢复重试成功；重复同步不回退');
{
  const ledger = emptyLedger();
  ledger.reports.push(makeReport('SR-R4', 'R4', 'active', [...configsA, ...configsB]));
  const projectA = makeProject('TA-A', '长续航四驱版', undefined, 'R4');
  const projectB = makeProject('TA-B', '标准厢式版', undefined, 'R4');
  const projects = [projectA, projectB];
  const batchInput = {
    note: '完整引用批次',
    references: [
      { projectId: 'TA-A', regulationId: 'REG-BATTERY', reportVersionId: 'SR-R4', configurations: configsA },
      { projectId: 'TA-B', regulationId: 'REG-BATTERY', reportVersionId: 'SR-R4', configurations: configsB }
    ]
  };

  const fail1 = applySyncBatch(ledger, projects, batchInput, { batchId: 'BAT-1', simulateFailure: true });
  check('失败批次 applied=false', fail1.applied === false && !!fail1.error);
  check('失败时未落任何引用', ledger.references.length === 0);
  check('批次被保留待恢复', ledger.batches[0].applied === false);

  const fail2 = applySyncBatch(ledger, projects, batchInput, { batchId: 'BAT-1', simulateFailure: true });
  check('再次失败仍是同一批次', fail2.batchId === 'BAT-1' && ledger.batches.length === 1);

  const retry = applySyncBatch(ledger, projects, batchInput, { batchId: 'BAT-1' });
  check('恢复重试成功', retry.applied === true && retry.alreadyApplied === false);
  check('两条引用已落账', ledger.references.length === 2);
  const refsSnapshot = JSON.stringify(ledger.references);

  const duplicate = applySyncBatch(ledger, projects, batchInput, { batchId: 'BAT-1' });
  check('重复同步返回 alreadyApplied', duplicate.alreadyApplied === true);
  check('重复同步不新增引用/批次', ledger.references.length === 2 && ledger.batches.length === 1);
  check('重复同步不改变引用账（无回退）', JSON.stringify(ledger.references) === refsSnapshot);

  // 一个全新批次号但内容相同：允许再次登记，但 registerReference 是幂等刷新
  const another = applySyncBatch(ledger, projects, batchInput, { batchId: 'BAT-2' });
  check('不同批次号可独立应用', another.applied === true && ledger.batches.length === 2);
}

console.log('场景 7：引用成环 → 列出链路并停住发布');
{
  const { ledger, projectA, projectB } = freshFixture();
  // R4 自引用形成环
  const r4 = ledger.reports.find((report) => report.version === 'R4')!;
  r4.dependsOn = [r4.id];
  const issues = detectChainIssues(ledger);
  check('检测到 1 个环', issues.filter((issue) => issue.type === 'cycle').length === 1);
  const cycle = issues.find((issue) => issue.type === 'cycle')!;
  check('链路包含起点并回到起点', cycle.chain[0] === r4.id && cycle.chain[cycle.chain.length - 1] === r4.id);
  const gateA = evaluatePublishGate(projectA, ledger);
  check('发布被停住', gateA.allowed === false);
  check('闸门携带链路问题', gateA.chainIssues.some((issue) => issue.type === 'cycle'));

  // 间接环：R4 -> X -> R4
  r4.dependsOn = [];
  ledger.reports.push(makeReport('SR-X', 'RX', 'active', configsA, { dependsOn: [r4.id], reportKey: 'KEY-OTHER', familyName: '其他报告' }));
  r4.dependsOn = ['SR-X'];
  const issues2 = detectChainIssues(ledger);
  check('检测到间接环', issues2.some((issue) => issue.type === 'cycle'));
  void projectB;
}

console.log('场景 8：来源丢失 → 列出 [引用 → 幽灵版本] 链路并停住发布');
{
  const { ledger, projectA } = freshFixture();
  referencesForProject(ledger, 'TA-A')[0].reportVersionId = 'SR-GHOST';
  const issues = detectChainIssues(ledger);
  const missing = issues.filter((issue) => issue.type === 'missing_source');
  check('检测到丢失来源', missing.length >= 1);
  check('链路从引用指向幽灵版本', missing[0].chain[0].startsWith('RR') && missing[0].chain[1] === 'SR-GHOST');
  recompute(ledger, [projectA], '2026-10-05T00:00:00.000Z');
  const gate = evaluatePublishGate(projectA, ledger);
  check('发布停住且证据失效', !gate.allowed && projectA.evidence[0].status === 'resubmit');
}

console.log('场景 9：历史提交包冻结在各自时间点，之后换版不回改');
{
  const { ledger, projectA } = freshFixture();
  const before = freezeSubmissionPackage(projectA, ledger, {
    label: '首版提交包',
    author: '审阅人',
    note: 'R4 时点冻结',
    at: '2026-09-10T00:00:00.000Z'
  });
  check('冻结包引用 R4', before.references[0]?.version === 'R4');
  check('冻结时法规 100%', before.regulationSnapshots[0].coverage === 100);

  publishReportVersion(
    ledger,
    { reportKey: BAT_KEY, familyName: '动力电池包安全测试报告', regulationId: 'REG-BATTERY', version: 'R5', configurations: ['长续航四驱版'] },
    '2026-10-01T00:00:00.000Z'
  );
  recompute(ledger, [projectA], '2026-10-01T01:00:00.000Z');
  check('换版后当前法规不再完整', projectA.regulations[0].status !== 'complete');
  check('历史包仍记录 R4 与 100%（未被回改）', before.references[0].version === 'R4' && before.regulationSnapshots[0].coverage === 100);

  registerReference(
    ledger,
    { projectId: 'TA-A', regulationId: 'REG-BATTERY', reportVersionId: ledger.reports.find((r) => r.version === 'R5')!.id, configurations: ['长续航四驱版'] },
    '2026-10-02T00:00:00.000Z'
  );
  projectA.evidence[0].configurations = ['长续航四驱版'];
  projectA.evidence[0].status = 'accepted';
  recompute(ledger, [projectA], '2026-10-02T01:00:00.000Z');
  const after = freezeSubmissionPackage(projectA, ledger, {
    label: '换版后提交包',
    author: '审阅人',
    note: 'R5 时点冻结',
    at: '2026-10-02T02:00:00.000Z'
  });
  check('新冻结包引用 R5', after.references[0]?.version === 'R5');
  check('两个时间点的提交包各自独立', projectA.packages.length === 0 && before.id !== after.id);
}

console.log('场景 10：重复重算幂等，不反复回退状态');
{
  const { ledger, projectA, projectB } = freshFixture();
  publishReportVersion(
    ledger,
    { reportKey: BAT_KEY, familyName: '动力电池包安全测试报告', regulationId: 'REG-BATTERY', version: 'R5', configurations: configsA },
    '2026-10-01T00:00:00.000Z'
  );
  recompute(ledger, [projectA, projectB], '2026-10-01T01:00:00.000Z');
  const snapshot = JSON.stringify({ ev: [projectA.evidence, projectB.evidence], regs: [projectA.regulations, projectB.regulations] });
  recompute(ledger, [projectA, projectB], '2026-10-01T02:00:00.000Z');
  recompute(ledger, [projectA, projectB], '2026-10-01T03:00:00.000Z');
  const after = JSON.stringify({ ev: [projectA.evidence, projectB.evidence], regs: [projectA.regulations, projectB.regulations] });
  check('连续重算结果稳定', snapshot === after);
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
