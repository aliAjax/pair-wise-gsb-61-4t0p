<script setup lang="ts">
import type { EvidenceStatus, ProjectInput, ProjectStatus } from '~/types/certification';
import { referenceHealthMap, referenceHealthMeta } from '~/services/reference-ledger';
import { validateEvidenceUpgrade, validateProjectInput, validateSubmission } from '~/services/validators';
import { useCertificationStore } from '~/stores/certification';

const route = useRoute();
const store = useCertificationStore();
const id = String(route.params.id);
const project = computed(() => store.projectById(id));
const activeTab = ref(0);
const message = ref('');
const error = ref('');

const editor = reactive<ProjectInput>({
  name: '',
  modelCode: '',
  vehicleType: '',
  configuration: '',
  maintenanceVersion: '',
  softwareVersion: '',
  applicant: '',
  agency: '',
  certificateExpiry: ''
});

watch(
  project,
  (value) => {
    if (!value) return;
    Object.assign(editor, {
      name: value.name,
      modelCode: value.modelCode,
      vehicleType: value.vehicleType,
      configuration: value.configuration,
      maintenanceVersion: value.maintenanceVersion,
      softwareVersion: value.softwareVersion,
      applicant: value.applicant,
      agency: value.agency,
      certificateExpiry: value.certificateExpiry
    });
  },
  { immediate: true }
);

const transitionStatus = ref<ProjectStatus>('under_review');
const transitionReason = ref('');
const editReason = ref('');
const supplementNote = ref('');
const selectedEvidence = ref<string[]>([]);

const tabs = [
  { label: '证据文件', icon: 'i-heroicons-document-text' },
  { label: '法规项目', icon: 'i-heroicons-list-bullet' },
  { label: '版本与影响', icon: 'i-heroicons-arrows-right-left' },
  { label: '审计记录', icon: 'i-heroicons-clock' },
  { label: '共享引用', icon: 'i-heroicons-link' }
];

const transitionOptions = computed(() => {
  const current = project.value?.status;
  if (current === 'draft') return [{ label: '提交认证机构', value: 'submitted' }];
  if (current === 'submitted') return [{ label: '开始审阅', value: 'under_review' }];
  if (current === 'under_review') {
    return [
      { label: '要求补件', value: 'supplement_required' },
      { label: '批准', value: 'approved' },
      { label: '拒绝', value: 'rejected' }
    ];
  }
  if (current === 'supplement_required') return [{ label: '重新提交补件', value: 'submitted' }];
  return [{ label: '重新打开审阅', value: 'under_review' }];
});

const blockingIssues = computed(() => {
  if (!project.value) return [];
  return validateSubmission(project.value, {
    references: store.references,
    reports: store.sharedReports,
    holds: store.publicationHolds(id)
  });
});

const projectReferences = computed(() => store.referencesByProject(id));
const projectHolds = computed(() => store.publicationHolds(id));
const healthMap = computed(() => referenceHealthMap(store.references, store.sharedReports));

/** 证据表内的共享源提示：换版、撤回或来源缺失时直接标在证据行上。 */
const sharedHints = computed(() => {
  const hints: Record<string, string> = {};
  projectReferences.value.forEach((ref) => {
    if (ref.status !== 'registered') return;
    const report = store.sharedReportById(ref.reportId);
    if (!report) {
      hints[ref.evidenceId] = `共享源 ${ref.reportId} 缺失，发布已停住`;
    } else if (report.status === 'withdrawn') {
      hints[ref.evidenceId] = `共享源 ${report.id} 已撤回，需重新登记来源`;
    } else if (report.currentVersion !== ref.reportVersion) {
      hints[ref.evidenceId] = `共享源 ${report.id} 已换版至 ${report.currentVersion}，引用 ${ref.reportVersion} 失效`;
    }
  });
  return hints;
});

const refForm = reactive({
  evidenceId: '',
  reportId: '',
  reportVersion: '',
  configurations: [] as string[],
  derivedFrom: ''
});

const refEvidenceOptions = computed(
  () => project.value?.evidence.map((item) => ({ label: `${item.name}（${item.id}）`, value: item.id })) ?? []
);
const refReportOptions = computed(() => {
  const evidence = project.value?.evidence.find((item) => item.id === refForm.evidenceId);
  return store.sharedReports
    .filter((report) => !evidence || report.regulationId === evidence.regulationId)
    .map((report) => ({ label: `${report.id} · ${report.name}（现行 ${report.currentVersion}）`, value: report.id }));
});
const refConfigOptions = computed(() => {
  if (!project.value) return [];
  const evidence = project.value.evidence.find((item) => item.id === refForm.evidenceId);
  return Array.from(new Set([project.value.configuration, ...(evidence?.configurations ?? [])]));
});
const refDerivedOptions = computed(() =>
  store.references
    .filter((ref) => ref.projectId !== id && ref.status === 'registered')
    .map((ref) => ({ label: `${ref.id} · ${ref.projectId} · ${ref.reportId}@${ref.reportVersion}`, value: ref.id }))
);

watch(
  () => refForm.evidenceId,
  () => {
    refForm.configurations = [...refConfigOptions.value];
  }
);
watch(
  () => refForm.reportId,
  (reportId) => {
    refForm.reportVersion = store.sharedReportById(reportId)?.currentVersion ?? '';
  }
);

function evidenceName(evidenceId: string) {
  return project.value?.evidence.find((item) => item.id === evidenceId)?.name ?? evidenceId;
}

function registerReference() {
  message.value = '';
  error.value = '';
  const result = store.registerReference(id, {
    evidenceId: refForm.evidenceId,
    reportId: refForm.reportId,
    reportVersion: refForm.reportVersion.trim(),
    configurations: [...refForm.configurations],
    derivedFrom: refForm.derivedFrom || undefined
  });
  if (!result.ok) {
    error.value = result.error ?? '引用登记失败';
    return;
  }
  refForm.evidenceId = '';
  refForm.reportId = '';
  refForm.reportVersion = '';
  refForm.configurations = [];
  refForm.derivedFrom = '';
  message.value = '共享报告引用已登记，源头换版或撤回时将按覆盖配置失效重算。';
}

function deregisterReference(refId: string) {
  store.deregisterReference(refId, '审阅人确认引用链异常，注销该登记。');
  message.value = `引用 ${refId} 已注销。`;
}

function saveEditor() {
  message.value = '';
  error.value = '';
  const errors = validateProjectInput(editor);
  if (Object.keys(errors).length) {
    error.value = Object.values(errors)[0] ?? '项目资料校验失败';
    return;
  }
  if (!editReason.value.trim()) {
    error.value = '请填写本次变更原因';
    return;
  }
  store.updateProject(id, { ...editor }, editReason.value);
  editReason.value = '';
  message.value = '项目资料与版本影响已保存。';
}

function transition() {
  if (!project.value) return;
  message.value = '';
  error.value = '';
  if (!transitionReason.value.trim()) {
    error.value = '请填写审批流转依据';
    return;
  }
  if (transitionStatus.value === 'approved' && blockingIssues.value.length) {
    error.value = `存在阻断项，不能批准：${blockingIssues.value.join('；')}`;
    return;
  }
  const ok = store.transition(id, transitionStatus.value, project.value.reviewer === '待分派' ? '认证机构审阅人' : project.value.reviewer, transitionReason.value);
  if (!ok) {
    error.value = '存在引用成环或来源缺失，发布已停住，请先在“共享引用”页签处理引用链。';
    return;
  }
  transitionReason.value = '';
  message.value = '审批状态已更新。';
}

function updateEvidence(evidenceId: string, status: EvidenceStatus) {
  if (!project.value) return;
  store.updateEvidence(id, evidenceId, status, `审阅人将证据标记为${status}`);
  message.value = '证据审阅状态已更新。';
}

function bulkSupplement() {
  if (!project.value) return;
  const errors = validateEvidenceUpgrade(project.value, selectedEvidence.value, supplementNote.value);
  if (errors.length) {
    error.value = errors.join('；');
    return;
  }
  const count = store.bulkSupplement(id, selectedEvidence.value, supplementNote.value);
  selectedEvidence.value = [];
  supplementNote.value = '';
  message.value = `已将 ${count} 项证据更新至当前软件基线并重新提交。`;
}
</script>

<template>
  <div v-if="!project" class="border border-red-200 bg-red-50 p-6 text-red-900">
    未找到认证项目 {{ id }}。
  </div>

  <template v-else>
    <div class="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <NuxtLink to="/" class="text-sm text-teal-700 hover:underline">返回认证项目</NuxtLink>
        <div class="mt-3 flex flex-wrap items-center gap-3">
          <h1 class="text-2xl font-semibold">{{ project.id }}</h1>
          <StatusBadge :status="project.status" />
        </div>
        <p class="mt-2 text-lg font-medium">{{ project.name }}</p>
        <p class="mt-1 text-sm text-slate-500">
          {{ project.modelCode }} · {{ project.vehicleType }} · {{ project.configuration }} · {{ project.maintenanceVersion }} / SW {{ project.softwareVersion }}
        </p>
      </div>
      <div class="min-w-[240px] border border-slate-200 bg-white p-4">
        <div class="flex items-center justify-between text-sm">
          <span class="text-slate-500">证据完整度</span>
          <span class="metric-value font-semibold">{{ project.progress }}%</span>
        </div>
        <UProgress class="mt-2" :value="project.progress" size="sm" />
        <p class="mt-2 text-xs text-slate-500">证书到期：{{ project.certificateExpiry }}</p>
      </div>
    </div>

    <div v-if="message" class="mb-4 border border-green-200 bg-green-50 p-3 text-sm text-green-900">{{ message }}</div>
    <div v-if="error" class="mb-4 border border-red-200 bg-red-50 p-3 text-sm text-red-900">{{ error }}</div>
    <div v-if="blockingIssues.length" class="mb-5 border border-amber-200 bg-amber-50 p-4">
      <p class="text-sm font-semibold text-amber-950">批准前阻断项</p>
      <ul class="mt-2 list-inside list-disc space-y-1 text-sm text-amber-900">
        <li v-for="issue in blockingIssues" :key="issue">{{ issue }}</li>
      </ul>
    </div>

    <section class="mb-6 grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
      <div class="border border-slate-200 bg-white p-5">
        <div class="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 class="font-semibold">项目与版本基线</h2>
            <p class="mt-1 text-xs text-slate-500">变更会生成新版本并标记受影响配置。</p>
          </div>
        </div>
        <form class="grid gap-4 md:grid-cols-2 xl:grid-cols-3" @submit.prevent="saveEditor">
          <UFormGroup label="项目名称"><UInput v-model="editor.name" /></UFormGroup>
          <UFormGroup label="车型代码"><UInput v-model="editor.modelCode" /></UFormGroup>
          <UFormGroup label="配置"><UInput v-model="editor.configuration" /></UFormGroup>
          <UFormGroup label="维护版本"><UInput v-model="editor.maintenanceVersion" /></UFormGroup>
          <UFormGroup label="软件版本"><UInput v-model="editor.softwareVersion" /></UFormGroup>
          <UFormGroup label="证书有效期"><UInput v-model="editor.certificateExpiry" type="date" /></UFormGroup>
          <UFormGroup label="申请主体"><UInput v-model="editor.applicant" /></UFormGroup>
          <UFormGroup label="认证机构"><UInput v-model="editor.agency" /></UFormGroup>
          <UFormGroup label="变更原因"><UInput v-model="editReason" placeholder="说明变更和影响范围" /></UFormGroup>
          <div class="md:col-span-2 xl:col-span-3">
            <UButton type="submit" color="primary">保存并生成版本</UButton>
          </div>
        </form>
      </div>

      <div class="border border-slate-200 bg-white p-5">
        <h2 class="font-semibold">审批流转</h2>
        <p class="mt-1 text-xs text-slate-500">批准前系统检查缺失证据、版本错配和配置覆盖。</p>
        <form class="mt-4 space-y-4" @submit.prevent="transition">
          <UFormGroup label="目标状态">
            <USelect v-model="transitionStatus" :options="transitionOptions" />
          </UFormGroup>
          <UFormGroup label="流转依据">
            <UTextarea v-model="transitionReason" :rows="3" placeholder="记录接受、拒绝或补件依据" />
          </UFormGroup>
          <UButton type="submit" color="primary" class="w-full justify-center">提交审批流转</UButton>
        </form>
      </div>
    </section>

    <UTabs v-model="activeTab" :items="tabs" class="mb-5" />

    <section v-if="activeTab === 0" class="border border-slate-200 bg-white">
      <div class="border-b border-slate-200 px-4 py-3">
        <h2 class="font-semibold">证据文件审阅</h2>
        <p class="mt-1 text-xs text-slate-500">逐项接受、拒绝或要求重新抽样。</p>
      </div>
      <EvidenceTable :evidence="project.evidence" :hints="sharedHints" editable @update="updateEvidence" />
    </section>

    <section v-else-if="activeTab === 1">
      <div class="mb-4">
        <h2 class="font-semibold">法规项目覆盖</h2>
        <p class="mt-1 text-sm text-slate-500">按法规项展开证据、配置覆盖和阻断问题。</p>
      </div>
      <RegulationTree :regulations="project.regulations" :evidence="project.evidence" />
    </section>

    <section v-else-if="activeTab === 2" class="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
      <div class="border border-slate-200 bg-white">
        <div class="border-b border-slate-200 px-4 py-3">
          <h2 class="font-semibold">版本差异</h2>
        </div>
        <div class="divide-y divide-slate-200">
          <article v-for="version in project.versions" :key="version.id" class="p-4">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p class="font-medium">{{ version.label }} · {{ version.author }}</p>
                <p class="mt-1 text-xs text-slate-500">{{ version.createdAt.slice(0, 16).replace('T', ' ') }}</p>
              </div>
              <UBadge color="gray" variant="soft">{{ version.impactedConfigurations.join('、') }}</UBadge>
            </div>
            <p class="mt-3 text-sm">{{ version.summary }}</p>
            <ul class="mt-2 list-inside list-disc text-sm text-slate-600">
              <li v-for="change in version.changes" :key="change">{{ change }}</li>
            </ul>
          </article>
        </div>
      </div>

      <div class="border border-slate-200 bg-white p-5">
        <h2 class="font-semibold">批量补件</h2>
        <p class="mt-1 text-xs text-slate-500">将缺失、被拒或待重交证据更新到当前软件基线。</p>
        <form class="mt-4 space-y-4" @submit.prevent="bulkSupplement">
          <label
            v-for="item in project.evidence.filter((evidence) => ['rejected', 'resubmit', 'missing'].includes(evidence.status))"
            :key="item.id"
            class="flex gap-3 border border-slate-200 p-3"
          >
            <input v-model="selectedEvidence" type="checkbox" :value="item.id" class="mt-1" />
            <span>
              <span class="block text-sm font-medium">{{ item.name }}</span>
              <span class="mt-1 block text-xs text-slate-500">{{ item.id }} · 当前 SW {{ item.softwareVersion }}</span>
            </span>
          </label>
          <p v-if="!project.evidence.some((evidence) => ['rejected', 'resubmit', 'missing'].includes(evidence.status))" class="text-sm text-slate-500">
            当前没有待补件证据。
          </p>
          <UFormGroup label="补件说明">
            <UTextarea v-model="supplementNote" :rows="3" placeholder="说明已完成的测试、配置覆盖和版本更新" />
          </UFormGroup>
          <UButton type="submit" color="primary" class="w-full justify-center">批量更新并重新提交</UButton>
        </form>
      </div>
    </section>

    <section v-else-if="activeTab === 3" class="border border-slate-200 bg-white p-5">
      <h2 class="font-semibold">项目审计记录</h2>
      <div class="mt-5 space-y-5">
        <article v-for="entry in project.audit" :key="entry.id" class="audit-item">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-sm font-medium">{{ entry.action }} · {{ entry.actor }}</p>
            <span class="text-xs text-slate-500">{{ entry.createdAt.slice(0, 16).replace('T', ' ') }}</span>
          </div>
          <p class="mt-1 text-sm text-slate-600">{{ entry.detail }}</p>
        </article>
      </div>
    </section>

    <section v-else class="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(320px,2fr)]">
      <div class="border border-slate-200 bg-white">
        <div class="border-b border-slate-200 px-4 py-3">
          <h2 class="font-semibold">共享报告引用登记</h2>
          <p class="mt-1 text-xs text-slate-500">项目引用的报告版本与覆盖配置；源头换版或撤回后按配置失效重算。</p>
        </div>
        <div v-if="projectHolds.length" class="border-b border-red-200 bg-red-50 px-4 py-3">
          <p class="text-sm font-semibold text-red-900">发布已停住</p>
          <ul class="mt-1 space-y-1 text-sm text-red-900">
            <li v-for="hold in projectHolds" :key="`${hold.referenceId}-${hold.chain.join('>')}`">
              {{ hold.kind === 'cycle' ? '引用成环' : '来源缺失' }}：{{ hold.chain.join(' → ') }}
            </li>
          </ul>
        </div>
        <div class="overflow-x-auto">
          <table class="data-table min-w-[860px]">
            <thead>
              <tr>
                <th>引用</th>
                <th>证据</th>
                <th>来源报告 / 版本</th>
                <th>覆盖配置</th>
                <th>上游引用</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="ref in projectReferences" :key="ref.id">
                <td class="font-mono text-sm">{{ ref.id }}</td>
                <td class="max-w-[200px] text-sm">{{ evidenceName(ref.evidenceId) }}</td>
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
                <td>
                  <UButton v-if="ref.status === 'registered'" size="xs" color="red" variant="soft" @click="deregisterReference(ref.id)">
                    注销
                  </UButton>
                  <span v-else class="text-xs text-slate-400">已注销</span>
                </td>
              </tr>
              <tr v-if="!projectReferences.length">
                <td colspan="7" class="py-10 text-center text-slate-500">尚未登记共享报告引用。</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="border border-slate-200 bg-white p-5">
        <h2 class="font-semibold">登记新引用</h2>
        <p class="mt-1 text-xs text-slate-500">从源账选择报告与版本，登记本项目证据的覆盖配置。</p>
        <form class="mt-4 space-y-4" @submit.prevent="registerReference">
          <UFormGroup label="项目证据">
            <USelect v-model="refForm.evidenceId" :options="refEvidenceOptions" placeholder="选择证据" />
          </UFormGroup>
          <UFormGroup label="共享报告">
            <USelect v-model="refForm.reportId" :options="refReportOptions" placeholder="选择来源报告" />
          </UFormGroup>
          <UFormGroup label="引用版本">
            <UInput v-model="refForm.reportVersion" placeholder="默认为源账现行版本" />
          </UFormGroup>
          <UFormGroup label="覆盖配置">
            <label v-for="config in refConfigOptions" :key="config" class="flex items-center gap-2 py-1 text-sm">
              <input v-model="refForm.configurations" type="checkbox" :value="config" class="mt-0.5" />
              {{ config }}
            </label>
            <p v-if="!refConfigOptions.length" class="text-xs text-slate-400">先选择证据。</p>
          </UFormGroup>
          <UFormGroup label="上游引用（可选）">
            <USelect v-model="refForm.derivedFrom" :options="[{ label: '无（直接登记自源账）', value: '' }, ...refDerivedOptions]" />
          </UFormGroup>
          <UButton type="submit" color="primary" class="w-full justify-center">登记引用</UButton>
        </form>
      </div>
    </section>
  </template>
</template>
