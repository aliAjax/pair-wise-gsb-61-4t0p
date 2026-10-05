<script setup lang="ts">
import { isPackageOutdated } from '~/services/reference-ledger';
import { useCertificationStore } from '~/stores/certification';

const store = useCertificationStore();
const selectedProject = ref('all');
const projectOptions = computed(() => [
  { label: '全部项目', value: 'all' },
  ...store.projects.map((project) => ({ label: `${project.id} · ${project.name}`, value: project.id }))
]);

const entries = computed(() =>
  store.projects
    .filter((project) => selectedProject.value === 'all' || project.id === selectedProject.value)
    .flatMap((project) =>
      project.audit.map((entry) => ({
        ...entry,
        projectId: project.id,
        projectName: project.name
      }))
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
);

const packages = computed(() =>
  store.packages
    .filter((pkg) => selectedProject.value === 'all' || pkg.projectId === selectedProject.value)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
);

const reasonLabels = {
  submit: '提交机构',
  approve: '批准锁定',
  export: '导出快照'
} as const;

function packageOutdated(pkg: (typeof packages.value)[number]) {
  return isPackageOutdated(pkg, store.projects, store.sharedReports);
}

function exportAudit() {
  const scoped = store.projects.filter((project) => selectedProject.value === 'all' || project.id === selectedProject.value);
  // 导出时点各冻结一份提交包，历史包不被后续源账变更回写。
  store.exportPackages(scoped.map((project) => project.id));
  const payload = {
    generatedAt: new Date().toISOString(),
    scope: selectedProject.value,
    projects: scoped.map((project) => ({
      id: project.id,
      status: project.status,
      maintenanceVersion: project.maintenanceVersion,
      softwareVersion: project.softwareVersion,
      versions: project.versions,
      evidence: project.evidence,
      audit: project.audit
    })),
    packages: store.packages.filter((pkg) => scoped.some((project) => project.id === pkg.projectId))
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'vehicle-type-approval-audit-package.json';
  anchor.click();
  URL.revokeObjectURL(url);
}

onMounted(() => store.hydrate());
</script>

<template>
  <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold">审计与提交包</h1>
      <p class="mt-1 text-sm text-slate-600">保留项目变更、证据审阅、状态流转和批量补件的完整轨迹。</p>
    </div>
    <div class="flex flex-wrap items-end gap-3">
      <div class="min-w-[300px]">
        <UFormGroup label="审计范围">
          <USelect v-model="selectedProject" :options="projectOptions" />
        </UFormGroup>
      </div>
      <UButton color="primary" @click="exportAudit">导出提交包</UButton>
    </div>
  </div>

  <section class="border border-slate-200 bg-white">
    <div class="border-b border-slate-200 px-4 py-3">
      <h2 class="font-semibold">审批时间线</h2>
      <p class="mt-1 text-xs text-slate-500">共 {{ entries.length }} 条记录</p>
    </div>
    <div class="space-y-5 p-5">
      <article v-for="entry in entries" :key="entry.id" class="audit-item">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-sm font-medium">{{ entry.action }} · {{ entry.actor }}</p>
          <span class="text-xs text-slate-500">{{ entry.createdAt.slice(0, 16).replace('T', ' ') }}</span>
        </div>
        <p class="mt-1 text-sm text-slate-600">{{ entry.detail }}</p>
        <p class="mt-1 text-xs text-slate-500">{{ entry.projectId }} · {{ entry.projectName }}</p>
      </article>
      <p v-if="!entries.length" class="py-10 text-center text-sm text-slate-500">没有符合条件的审计记录。</p>
    </div>
  </section>

  <section class="mt-6 border border-slate-200 bg-white">
    <div class="border-b border-slate-200 px-4 py-3">
      <h2 class="font-semibold">提交包时间点</h2>
      <p class="mt-1 text-xs text-slate-500">
        每次提交、批准或导出都冻结当时的证据与引用版本；后续源账换版或撤回不回写历史包，仅标记其与当前账的差异。
      </p>
    </div>
    <div class="divide-y divide-slate-200">
      <article v-for="pkg in packages" :key="pkg.id" class="p-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-sm font-medium">
            {{ pkg.projectId }} · {{ reasonLabels[pkg.reason] }} ·
            <span class="text-slate-500">{{ pkg.createdAt.slice(0, 16).replace('T', ' ') }}</span>
          </p>
          <UBadge :color="packageOutdated(pkg) ? 'amber' : 'green'" variant="soft">
            {{ packageOutdated(pkg) ? '已被后续源账变更影响' : '与当前账一致' }}
          </UBadge>
        </div>
        <p class="mt-1 text-sm text-slate-600">证据 {{ pkg.evidence.length }} 项 · 引用 {{ pkg.references.length }} 项</p>
        <p v-if="pkg.references.length" class="mt-1 font-mono text-xs text-slate-500">
          {{ pkg.references.map((ref) => `${ref.reportId}@${ref.reportVersion}`).join('、') }}
        </p>
      </article>
      <p v-if="!packages.length" class="py-10 text-center text-sm text-slate-500">
        暂无提交包；项目提交、批准或点击“导出提交包”后在此按时间点列出。
      </p>
    </div>
  </section>
</template>
