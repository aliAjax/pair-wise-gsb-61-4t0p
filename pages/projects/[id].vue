<script setup lang="ts">
import type { EvidenceStatus, ProjectInput, ProjectStatus } from '~/types/certification';
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

const packageLabel = ref('');
const packageNote = ref('');

const tabs = [
  { label: '证据文件', icon: 'i-heroicons-document-text' },
  { label: '法规项目', icon: 'i-heroicons-list-bullet' },
  { label: '版本与影响', icon: 'i-heroicons-arrows-right-left' },
  { label: '历史提交包', icon: 'i-heroicons-archive-box' },
  { label: '审计记录', icon: 'i-heroicons-clock' }
];

const transitionOptions = computed(() => {
  const current = project.value?.status;
  if (current === 'draft') return [{ label: '提交认证机构（发布）', value: 'submitted' }];
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

const gate = computed(() => (project.value ? store.publishGate(project.value.id) : null));
const blockingIssues = computed(() =>
  project.value ? validateSubmission(project.value, store.ledger) : []
);
const references = computed(() => (project.value ? store.projectReferences(project.value.id) : []));

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
  message.value = '项目资料、版本影响与引用账已重算并保存。';
}

function transition() {
  if (!project.value) return;
  message.value = '';
  error.value = '';
  if (!transitionReason.value.trim()) {
    error.value = '请填写审批流转依据';
    return;
  }
  const result = store.transition(
    id,
    transitionStatus.value,
    project.value.reviewer === '待分派' ? '认证机构审阅人' : project.value.reviewer,
    transitionReason.value
  );
  if (!result.ok) {
    error.value = `发布已停住：${(result.issues ?? []).join('；')}`;
    return;
  }
  transitionReason.value = '';
  message.value = '审批状态已更新。';
}

function updateEvidence(evidenceId: string, status: EvidenceStatus) {
  if (!project.value) return;
  store.updateEvidence(id, evidenceId, status, `审阅人将证据标记为${status}`);
  message.value = '证据审阅状态已更新，法规完整性已重算。';
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

function freezePackage() {
  if (!project.value) return;
  message.value = '';
  error.value = '';
  if (!packageLabel.value.trim() || !packageNote.value.trim()) {
    error.value = '请填写提交包名称和冻结说明';
    return;
  }
  store.freezePackage(id, packageLabel.value.trim(), packageNote.value.trim(), project.value.applicant);
  packageLabel.value = '';
  packageNote.value = '';
  message.value = '历史提交包已按当前时间点冻结；后续源头换版/撤回不会回改它。';
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

    <div v-if="gate && gate.chainIssues.length" class="mb-5 border border-red-300 bg-red-50 p-4">
      <p class="text-sm font-semibold text-red-950">引用链路问题，发布已停住</p>
      <div v-for="(chain, index) in gate.chainIssues" :key="index" class="mt-3">
        <UBadge color="red" variant="soft" class="mb-1">{{ chain.type === 'cycle' ? '引用成环' : '来源丢失' }}</UBadge>
        <p class="font-mono text-xs text-red-900">{{ chain.chain.join('  →  ') }}</p>
        <p class="mt-1 text-sm text-red-900">{{ chain.detail }}</p>
      </div>
      <NuxtLink to="/ledger" class="mt-3 inline-block text-sm font-medium text-teal-700 hover:underline">前往共享报告引用账处理 →</NuxtLink>
    </div>

    <div v-if="blockingIssues.length" class="mb-5 border border-amber-200 bg-amber-50 p-4">
      <p class="text-sm font-semibold text-amber-950">批准前阻断项（按当前时间点实时计算）</p>
      <ul class="mt-2 list-inside list-disc space-y-1 text-sm text-amber-900">
        <li v-for="issue in blockingIssues" :key="issue">{{ issue }}</li>
      </ul>
    </div>

    <section class="mb-6 grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
      <div class="border border-slate-200 bg-white p-5">
        <div class="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 class="font-semibold">项目与版本基线</h2>
            <p class="mt-1 text-xs text-slate-500">变更会生成新版本并触发共享引用证据重算。</p>
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
        <p class="mt-1 text-xs text-slate-500">提交/批准前检查法规完整性、失效配置与引用链路；成环或丢失来源直接停住。</p>
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

    <section v-if="references.length" class="mb-6 border border-teal-200 bg-teal-50/60 p-4">
      <h2 class="text-sm font-semibold text-teal-950">共享报告引用登记</h2>
      <div class="mt-3 grid gap-3 md:grid-cols-2">
        <div v-for="ref in references" :key="ref.id" class="border border-teal-100 bg-white p-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-sm font-medium">{{ ref.familyName }} {{ ref.reportVersionLabel }}</p>
            <UBadge
              :color="ref.staleConfigurations.length || ref.uncoveredConfigurations.length ? 'red' : 'green'"
              variant="soft"
            >
              {{ ref.staleConfigurations.length || ref.uncoveredConfigurations.length ? '存在失效配置' : '引用有效' }}
            </UBadge>
          </div>
          <p class="mt-2 text-xs text-slate-500">登记 {{ ref.id }} · 覆盖 {{ ref.configurations.join('、') }}</p>
          <p v-if="ref.validConfigurations.length" class="mt-1 text-xs text-green-700">当前有效：{{ ref.validConfigurations.join('、') }}</p>
          <p v-if="ref.staleConfigurations.length" class="mt-1 text-xs text-red-700">源头换版/撤回失效：{{ ref.staleConfigurations.join('、') }}</p>
          <p v-if="ref.uncoveredConfigurations.length" class="mt-1 text-xs text-amber-700">超出源头覆盖：{{ ref.uncoveredConfigurations.join('、') }}</p>
        </div>
      </div>
      <NuxtLink to="/ledger" class="mt-3 inline-block text-xs font-medium text-teal-700 hover:underline">在引用账中换版刷新或重新登记 →</NuxtLink>
    </section>

    <UTabs v-model="activeTab" :items="tabs" class="mb-5" />

    <section v-if="activeTab === 0" class="border border-slate-200 bg-white">
      <div class="border-b border-slate-200 px-4 py-3">
        <h2 class="font-semibold">证据文件审阅</h2>
        <p class="mt-1 text-xs text-slate-500">带共享引用标记的证据随源头换版/撤回按配置失效，恢复有效后需重新审阅。</p>
      </div>
      <EvidenceTable :evidence="project.evidence" editable @update="updateEvidence" />
    </section>

    <section v-else-if="activeTab === 1">
      <div class="mb-4">
        <h2 class="font-semibold">法规项目覆盖</h2>
        <p class="mt-1 text-sm text-slate-500">完整性按当前时间点实时重算：共享引用、失效配置与版本冲突都会体现。</p>
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
        <p class="mt-1 text-xs text-slate-500">将缺失、被拒、待重交或因源头变更失效的证据更新到当前软件基线。</p>
        <form class="mt-4 space-y-4" @submit.prevent="bulkSupplement">
          <label
            v-for="item in project.evidence.filter((evidence) => ['rejected', 'resubmit', 'missing'].includes(evidence.status))"
            :key="item.id"
            class="flex gap-3 border border-slate-200 p-3"
          >
            <input v-model="selectedEvidence" type="checkbox" :value="item.id" class="mt-1" />
            <span>
              <span class="block text-sm font-medium">{{ item.name }}</span>
              <span class="mt-1 block text-xs text-slate-500">
                {{ item.id }} · 当前 SW {{ item.softwareVersion }}
                <template v-if="(item.invalidatedConfigurations ?? []).length"> · 失效 {{ item.invalidatedConfigurations!.join('、') }}</template>
              </span>
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

    <section v-else-if="activeTab === 3" class="grid gap-6 xl:grid-cols-[minmax(320px,1fr)_minmax(0,2fr)]">
      <div class="border border-slate-200 bg-white p-5">
        <h2 class="font-semibold">冻结新提交包</h2>
        <p class="mt-1 text-xs text-slate-500">按当前时间点固化法规完整性与共享报告版本；之后源头换版/撤回不回改历史包。</p>
        <form class="mt-4 space-y-4" @submit.prevent="freezePackage">
          <UFormGroup label="提交包名称">
            <UInput v-model="packageLabel" placeholder="如：正式批准提交包" />
          </UFormGroup>
          <UFormGroup label="冻结说明">
            <UTextarea v-model="packageNote" :rows="3" placeholder="记录冻结时点、审阅结论" />
          </UFormGroup>
          <UButton type="submit" color="primary" class="w-full justify-center">冻结当前证据状态</UButton>
        </form>
      </div>

      <div class="space-y-4">
        <div v-if="!project.packages.length" class="border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          尚无历史提交包。
        </div>
        <article v-for="pkg in [...project.packages].reverse()" :key="pkg.id" class="border border-slate-200 bg-white p-5">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p class="font-medium">{{ pkg.label }}</p>
              <p class="mt-1 text-xs text-slate-500">{{ pkg.createdAt.slice(0, 16).replace('T', ' ') }} · {{ pkg.author }} · {{ pkg.id }}</p>
            </div>
            <UBadge color="gray" variant="soft">冻结时点</UBadge>
          </div>
          <p class="mt-3 text-sm text-slate-600">{{ pkg.note }}</p>

          <div class="mt-4">
            <p class="text-xs font-semibold text-slate-500">冻结时法规完整性</p>
            <div class="mt-2 flex flex-wrap gap-2">
              <UBadge
                v-for="snapshot in pkg.regulationSnapshots"
                :key="snapshot.regulationId"
                :color="snapshot.status === 'complete' ? 'green' : snapshot.status === 'conflict' ? 'red' : 'amber'"
                variant="soft"
              >
                {{ snapshot.code }} {{ snapshot.coverage }}%
              </UBadge>
            </div>
          </div>

          <div v-if="pkg.references.length" class="mt-4">
            <p class="text-xs font-semibold text-slate-500">冻结时共享报告版本（不随后续换版改变）</p>
            <ul class="mt-2 space-y-1 text-xs text-slate-600">
              <li v-for="ref in pkg.references" :key="ref.refId" class="font-mono">
                {{ ref.reportKey }} · {{ ref.version }} · {{ ref.configurations.join('、') }}
              </li>
            </ul>
          </div>

          <details class="mt-4 text-xs text-slate-500">
            <summary class="cursor-pointer">查看证据版本指纹（{{ pkg.evidenceFingerprints.length }}）</summary>
            <ul class="mt-2 space-y-1 font-mono">
              <li v-for="fp in pkg.evidenceFingerprints" :key="fp.evidenceId">
                {{ fp.evidenceId }} · {{ fp.name }} · {{ fp.version }} · {{ fp.configurations.join('、') }}
              </li>
            </ul>
          </details>
        </article>
      </div>
    </section>

    <section v-else class="border border-slate-200 bg-white p-5">
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
  </template>
</template>
