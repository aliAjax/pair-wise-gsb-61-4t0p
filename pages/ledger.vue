<script setup lang="ts">
import { analyzeReferenceChains, referenceHealthMap, referenceHealthMeta } from '~/services/reference-ledger';
import type { SyncBatch } from '~/types/certification';
import { useCertificationStore } from '~/stores/certification';

interface DemoBatch extends SyncBatch {
  description: string;
  simulateFailure?: boolean;
}

const store = useCertificationStore();
const message = ref('');
const error = ref('');

const demoBatches: DemoBatch[] = [
  {
    id: 'BATCH-2026-1005-R5',
    label: '电池包报告换版 R4 → R5',
    description: 'SHR-BAT-21700 新增热扩散测试工况，现行版本升为 R5，全部 R4 引用按配置失效重算。',
    createdAt: '2026-10-05T09:00:00.000Z',
    items: [
      {
        reportId: 'SHR-BAT-21700',
        action: 'update',
        version: { version: 'R5', issuedAt: '2026-10-05', status: 'active', note: '新增热扩散测试工况，替代 R4。' }
      }
    ]
  },
  {
    id: 'BATCH-2026-1005-MIX',
    label: 'EMC 与电池包联合批次（模拟通道中断）',
    description: '先在 EMC 报告应用后模拟源账通道中断，用于演练“从完整引用批次恢复重试”。',
    createdAt: '2026-10-05T09:30:00.000Z',
    simulateFailure: true,
    items: [
      {
        reportId: 'SHR-EMC-01',
        action: 'update',
        version: { version: 'R3', issuedAt: '2026-10-05', status: 'active', note: '补充充电工况辐射发射数据。' }
      },
      {
        reportId: 'SHR-BAT-21700',
        action: 'update',
        version: { version: 'R6', issuedAt: '2026-10-05', status: 'active', note: '更新振动试验夹具说明。' }
      }
    ]
  },
  {
    id: 'BATCH-2026-1005-WD',
    label: '撤回电池包报告',
    description: 'SHR-BAT-21700 整份撤回，全部引用配置证据失效为缺失，需重新登记来源。',
    createdAt: '2026-10-05T10:00:00.000Z',
    items: [{ reportId: 'SHR-BAT-21700', action: 'withdraw' }]
  }
];

const selectedBatchId = ref(demoBatches[0].id);
const selectedBatch = computed(() => demoBatches.find((batch) => batch.id === selectedBatchId.value) ?? demoBatches[0]);
const batchOptions = demoBatches.map((batch) => ({ label: `${batch.id} · ${batch.label}`, value: batch.id }));

const healthMap = computed(() => referenceHealthMap(store.references, store.sharedReports));
const holds = computed(() => analyzeReferenceChains(store.references, store.sharedReports));
const staleReferenceCount = computed(
  () =>
    store.references.filter((ref) => {
      const health = healthMap.value.get(ref.id);
      return health === 'stale' || health === 'lost_source' || health === 'cycle';
    }).length
);
const heldProjectIds = computed(() => Array.from(new Set(holds.value.map((hold) => hold.projectId))));
const activeReferenceCount = computed(() => store.references.filter((ref) => ref.status === 'registered').length);

const syncKindMeta: Record<string, { label: string; color: 'gray' | 'blue' | 'amber' | 'green' | 'red' }> = {
  applied: { label: '已应用', color: 'green' },
  failed: { label: '同步失败', color: 'red' },
  recovered: { label: '恢复重试', color: 'blue' },
  skipped: { label: '重复已跳过', color: 'gray' }
};

function projectLabel(projectId: string) {
  const project = store.projectById(projectId);
  return project ? `${project.id} · ${project.name}` : projectId;
}

function evidenceLabel(projectId: string, evidenceId: string) {
  const project = store.projectById(projectId);
  return project?.evidence.find((item) => item.id === evidenceId)?.name ?? evidenceId;
}

function applyBatch() {
  message.value = '';
  error.value = '';
  const batch = selectedBatch.value;
  const result = store.applySourceBatch(batch, { simulateFailure: batch.simulateFailure });
  if (result.skipped) {
    message.value = `批次 ${batch.id} 此前已完整应用，重复同步被忽略，未发生回退。`;
  } else if (result.ok) {
    message.value = `批次 ${batch.id} 应用完成：${result.effects?.invalidated.length ?? 0} 项证据失效，${result.effects?.recomputedRegulations.length ?? 0} 项法规完整性重算。`;
  } else {
    error.value = result.error ?? '源账同步失败。';
  }
}

function recover() {
  message.value = '';
  error.value = '';
  const result = store.recoverFailedSync();
  if (result.ok) {
    message.value = `已从完整引用批次恢复并重试成功：${result.effects?.invalidated.length ?? 0} 项证据失效重算。`;
  } else {
    error.value = result.error ?? '恢复失败。';
  }
}

function deregister(refId: string) {
  store.deregisterReference(refId, '审阅人确认引用链异常，注销该登记。');
  message.value = `引用 ${refId} 已注销，相关发布阻断按当前账重新评估。`;
}

onMounted(() => store.hydrate());
</script>

<template>
  <div class="mb-6">
    <h1 class="text-2xl font-semibold">共享报告引用账</h1>
    <p class="mt-1 text-sm text-slate-600">
      多车型共用的试验报告登记在源账，各项目按版本和覆盖配置登记引用；源头换版或撤回后，受影响配置的证据失效重算。
    </p>
  </div>

  <section class="workspace-grid mb-6">
    <div class="col-span-12 sm:col-span-6 xl:col-span-3">
      <StatTile label="源账共享报告" :value="store.sharedReports.length" note="多车型共用的试验报告" />
    </div>
    <div class="col-span-12 sm:col-span-6 xl:col-span-3">
      <StatTile label="登记引用" :value="activeReferenceCount" note="项目登记的报告版本与覆盖配置" />
    </div>
    <div class="col-span-12 sm:col-span-6 xl:col-span-3">
      <StatTile label="失效 / 异常引用" :value="staleReferenceCount" note="版本落后、来源缺失或引用成环" />
    </div>
    <div class="col-span-12 sm:col-span-6 xl:col-span-3">
      <StatTile label="发布阻断项目" :value="heldProjectIds.length" note="引用链异常，停住发布" />
    </div>
  </section>

  <div v-if="message" class="mb-4 border border-green-200 bg-green-50 p-3 text-sm text-green-900">{{ message }}</div>
  <div v-if="error" class="mb-4 border border-red-200 bg-red-50 p-3 text-sm text-red-900">{{ error }}</div>

  <section class="mb-6 grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(320px,2fr)]">
    <div class="border border-slate-200 bg-white p-5">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="font-semibold">源账同步</h2>
          <p class="mt-1 text-xs text-slate-500">
            法规完整性在批次应用时重算，审批阻断在提交/批准时按当前账校验，历史提交包冻结在各自生成时点。
          </p>
        </div>
        <UBadge color="gray" variant="soft">恢复点：{{ store.syncCheckpoint?.batchId ?? 'SEED（初始完整账）' }}</UBadge>
      </div>

      <div class="mt-4 grid gap-4 md:grid-cols-2">
        <UFormGroup label="同步批次">
          <USelect v-model="selectedBatchId" :options="batchOptions" />
        </UFormGroup>
        <div class="flex items-end gap-2">
          <UButton color="primary" :disabled="Boolean(store.pendingSyncFailure)" @click="applyBatch">应用批次</UButton>
          <UButton v-if="store.pendingSyncFailure" color="amber" @click="recover">从完整批次恢复重试</UButton>
        </div>
      </div>
      <p class="mt-2 text-sm text-slate-600">{{ selectedBatch.description }}</p>

      <div v-if="store.pendingSyncFailure" class="mt-4 border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        <p class="font-semibold">待恢复：{{ store.pendingSyncFailure.batchId }}</p>
        <p class="mt-1">
          {{ store.pendingSyncFailure.reason }}（{{ store.pendingSyncFailure.failedAt.slice(0, 16).replace('T', ' ') }}）
          {{ store.pendingSyncFailure.recovered ? '已回退一次，重试不再重复回退。' : '尚未回退。' }}
        </p>
      </div>
    </div>

    <div class="border border-slate-200 bg-white">
      <div class="border-b border-slate-200 px-4 py-3">
        <h2 class="font-semibold">同步日志</h2>
        <p class="mt-1 text-xs text-slate-500">批次应用、失败、恢复与重复跳过都留痕。</p>
      </div>
      <div class="max-h-[320px] space-y-3 overflow-y-auto p-4">
        <article v-for="entry in store.syncLog" :key="entry.id" class="audit-item">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-sm font-medium">
              <UBadge :color="syncKindMeta[entry.kind]?.color ?? 'gray'" variant="soft">{{ syncKindMeta[entry.kind]?.label ?? entry.kind }}</UBadge>
              <span class="ml-2">{{ entry.batchId }}</span>
            </p>
            <span class="text-xs text-slate-500">{{ entry.createdAt.slice(0, 16).replace('T', ' ') }}</span>
          </div>
          <p class="mt-1 text-sm text-slate-600">{{ entry.detail }}</p>
        </article>
        <p v-if="!store.syncLog.length" class="py-8 text-center text-sm text-slate-500">尚未发生源账同步。</p>
      </div>
    </div>
  </section>

  <section v-if="holds.length" class="mb-6 border border-red-200 bg-red-50">
    <div class="border-b border-red-200 px-4 py-3">
      <h2 class="font-semibold text-red-950">发布阻断：引用成环 / 丢失来源</h2>
      <p class="mt-1 text-xs text-red-800">以下项目的提交与批准已停住，处理异常引用后自动解除。</p>
    </div>
    <div class="divide-y divide-red-100">
      <article v-for="hold in holds" :key="`${hold.referenceId}-${hold.chain.join('>')}`" class="px-4 py-3">
        <p class="text-sm font-medium text-red-950">
          {{ projectLabel(hold.projectId) }} · {{ hold.kind === 'cycle' ? '引用成环' : '丢失来源' }}
        </p>
        <p class="mt-1 font-mono text-xs text-red-900">{{ hold.chain.join(' → ') }}</p>
      </article>
    </div>
  </section>

  <section class="mb-6 border border-slate-200 bg-white">
    <div class="border-b border-slate-200 px-4 py-3">
      <h2 class="font-semibold">共享报告源账</h2>
      <p class="mt-1 text-xs text-slate-500">源头维护的报告版本线，换版或撤回后驱动各项目引用失效重算。</p>
    </div>
    <div class="overflow-x-auto">
      <table class="data-table min-w-[920px]">
        <thead>
          <tr>
            <th>报告</th>
            <th>法规项</th>
            <th>出具方</th>
            <th>现行版本</th>
            <th>状态</th>
            <th>版本线</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="report in store.sharedReports" :key="report.id">
            <td>
              <p class="font-medium">{{ report.name }}</p>
              <p class="mt-1 font-mono text-xs text-slate-500">{{ report.id }}</p>
            </td>
            <td class="font-mono text-sm">{{ report.regulationId }}</td>
            <td class="text-sm">{{ report.owner }}</td>
            <td class="font-mono text-sm">{{ report.currentVersion }}</td>
            <td>
              <UBadge :color="report.status === 'active' ? 'green' : 'red'" variant="soft">
                {{ report.status === 'active' ? '有效' : '已撤回' }}
              </UBadge>
            </td>
            <td>
              <p v-for="version in report.versions" :key="version.version" class="text-xs text-slate-600">
                <span class="font-mono">{{ version.version }}</span>
                · {{ version.issuedAt }} ·
                {{ version.status === 'active' ? '现行' : version.status === 'superseded' ? '已被替代' : '已撤回' }} · {{ version.note }}
              </p>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>

  <section class="border border-slate-200 bg-white">
    <div class="border-b border-slate-200 px-4 py-3">
      <h2 class="font-semibold">引用账</h2>
      <p class="mt-1 text-xs text-slate-500">各项目登记的报告版本、覆盖配置与上游引用；异常引用可注销。</p>
    </div>
    <div class="overflow-x-auto">
      <table class="data-table min-w-[1120px]">
        <thead>
          <tr>
            <th>引用</th>
            <th>认证项目</th>
            <th>证据</th>
            <th>来源报告 / 版本</th>
            <th>覆盖配置</th>
            <th>上游引用</th>
            <th>状态</th>
            <th>登记时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="ref in store.references" :key="ref.id">
            <td class="font-mono text-sm">{{ ref.id }}</td>
            <td class="max-w-[220px] text-sm">{{ projectLabel(ref.projectId) }}</td>
            <td class="max-w-[200px] text-sm">{{ evidenceLabel(ref.projectId, ref.evidenceId) }}</td>
            <td>
              <p class="font-mono text-sm">{{ ref.reportId }}@{{ ref.reportVersion }}</p>
              <p v-if="store.sharedReportById(ref.reportId)" class="mt-1 text-xs text-slate-500">
                现行 {{ store.sharedReportById(ref.reportId)?.currentVersion }}
              </p>
              <p v-else class="mt-1 text-xs text-red-700">源账中不存在</p>
            </td>
            <td class="max-w-[180px] text-sm">{{ ref.configurations.join('、') }}</td>
            <td class="font-mono text-xs">{{ ref.derivedFrom ?? '—' }}</td>
            <td>
              <UBadge :color="referenceHealthMeta[healthMap.get(ref.id) ?? 'valid'].color" variant="soft">
                {{ referenceHealthMeta[healthMap.get(ref.id) ?? 'valid'].label }}
              </UBadge>
            </td>
            <td class="text-xs text-slate-500">{{ ref.registeredAt.slice(0, 16).replace('T', ' ') }}</td>
            <td>
              <UButton v-if="ref.status === 'registered'" size="xs" color="red" variant="soft" @click="deregister(ref.id)">
                注销
              </UButton>
              <span v-else class="text-xs text-slate-400">已注销</span>
            </td>
          </tr>
          <tr v-if="!store.references.length">
            <td colspan="9" class="py-12 text-center text-slate-500">引用账为空。</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
