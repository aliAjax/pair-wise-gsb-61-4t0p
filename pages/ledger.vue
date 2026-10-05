<script setup lang="ts">
import { useCertificationStore } from '~/stores/certification';
import type { PublishReportInput } from '~/services/reference-ledger';
import { referenceView } from '~/services/reference-ledger';
import type { SharedReportVersion } from '~/types/certification';

const store = useCertificationStore();
const message = ref('');
const error = ref('');

/* ---------------- 源头报告发布 ---------------- */
const publishForm = reactive<{
  reportKey: string;
  familyName: string;
  regulationId: string;
  version: string;
  configurations: string;
  dependsOn: string;
  note: string;
}>({
  reportKey: 'KEY-BAT-PACK-A',
  familyName: '动力电池包安全测试报告',
  regulationId: 'REG-BATTERY',
  version: 'R5',
  configurations: '长续航四驱版,标准续航后驱版,标准厢式版',
  dependsOn: '',
  note: '源头换版登记'
});

const familyOptions = computed(() => {
  const keys = new Map<string, { familyName: string; regulationId: string }>();
  for (const report of store.ledger.reports) {
    if (!keys.has(report.reportKey)) keys.set(report.reportKey, { familyName: report.familyName, regulationId: report.regulationId });
  }
  return [...keys.entries()].map(([reportKey, value]) => ({ reportKey, ...value }));
});

function publish() {
  message.value = '';
  error.value = '';
  try {
    const input: PublishReportInput = {
      reportKey: publishForm.reportKey || undefined,
      familyName: publishForm.familyName.trim(),
      regulationId: publishForm.regulationId,
      version: publishForm.version.trim(),
      configurations: splitConfigs(publishForm.configurations),
      dependsOn: publishForm.dependsOn.trim() ? splitConfigs(publishForm.dependsOn) : undefined,
      note: publishForm.note
    };
    if (!input.version || !input.configurations.length) {
      error.value = '请填写新版本号和覆盖配置';
      return;
    }
    store.publishSharedReport(input, '源头实验室');
    message.value = `已发布 ${input.familyName} ${input.version}，旧版引用的受影响配置证据已失效重算。`;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function withdraw(report: SharedReportVersion) {
  message.value = '';
  error.value = '';
  store.withdrawSharedReport(report.id, '源头撤回试验结论', '源头实验室');
  message.value = `${report.familyName} ${report.version} 已撤回，所有引用该版本的配置证据失效。`;
}

/* ---------------- 项目引用登记 ---------------- */
const registerForm = reactive({
  projectId: 'TA-2026-120',
  regulationId: 'REG-BATTERY',
  reportVersionId: 'SR-BAT-R4',
  configurations: '标准厢式版'
});

function register() {
  message.value = '';
  error.value = '';
  try {
    store.registerProjectReference(
      registerForm.projectId,
      {
        regulationId: registerForm.regulationId,
        reportVersionId: registerForm.reportVersionId,
        configurations: splitConfigs(registerForm.configurations)
      },
      '认证工程师'
    );
    message.value = '共享引用已登记/刷新，覆盖配置已重新计算有效性。';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

const projectOptions = computed(() =>
  store.projects.map((project) => ({ label: `${project.id} · ${project.name}`, value: project.id }))
);
const reportVersionOptions = computed(() =>
  store.ledger.reports.map((report) => ({
    label: `${report.familyName} ${report.version}（${report.status === 'active' ? '有效' : report.status === 'superseded' ? '已换版' : '已撤回'}）`,
    value: report.id
  }))
);

const allReferenceViews = computed(() =>
  store.ledger.references.map((ref) => referenceView(store.ledger, ref))
);

function projectName(id: string) {
  return store.projectById(id)?.name ?? id;
}

/* ---------------- 源账批次同步 ---------------- */
const simulateFailure = ref(true);
const batchDraft = reactive({ refs: 'TA-2026-118:REG-BATTERY:SR-BAT-R4:长续航四驱版,标准续航后驱版|TA-2026-120:REG-BATTERY:SR-BAT-R4:标准厢式版' });
const batches = computed(() => [...store.ledger.batches].sort((a, b) => b.syncedAt.localeCompare(a.syncedAt)));

function parseBatchDraft() {
  return batchDraft.refs
    .split('|')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const [projectId, regulationId, reportVersionId, configs] = segment.split(':');
      return { projectId, regulationId, reportVersionId, configurations: splitConfigs(configs ?? '') };
    });
}

function syncBatch() {
  message.value = '';
  error.value = '';
  const references = parseBatchDraft();
  if (!references.length) {
    error.value = '请按 项目:法规:报告版本:配置 的格式填写完整批次';
    return;
  }
  const result = store.syncSourceBatch(
    { note: simulateFailure.value ? '源账同步（含失败演练）' : '源账同步（正常批次）', references },
    { simulateFailure: simulateFailure.value }
  );
  if (result.applied && !result.alreadyApplied) message.value = `批次 ${result.batchId} 完整应用，引用账已重算。`;
  else if (result.alreadyApplied) message.value = `批次 ${result.batchId} 此前已应用，重复同步已跳过，未发生回退。`;
  else error.value = `批次 ${result.batchId} 同步失败：${result.error}。完整批次已保留，可从下方恢复重试。`;
}

function retry(batchId: string, failAgain: boolean) {
  message.value = '';
  error.value = '';
  const result = store.retryBatch(batchId, failAgain);
  if (!result) {
    error.value = '未找到该批次';
    return;
  }
  if (result.applied && !result.alreadyApplied) message.value = `批次 ${batchId} 恢复重试成功，完整引用批次已落账并重算。`;
  else if (result.alreadyApplied) message.value = `批次 ${batchId} 已应用，重复重试直接跳过。`;
  else error.value = `批次 ${batchId} 重试仍失败：${result.error}`;
}

/* ---------------- 链路问题（成环 / 丢失来源） ---------------- */
const chainIssues = computed(() => store.chainIssues);

function inject(kind: 'cycle' | 'missing_source' | 'clear') {
  message.value = '';
  error.value = '';
  store.injectChainScenario(kind);
  if (kind === 'cycle') message.value = '已注入自引用成环，所有项目的发布将被停住。';
  else if (kind === 'missing_source') message.value = '已让首条引用指向丢失来源，相关项目发布将被停住。';
  else message.value = '链路问题已清除。';
}

function gateFor(projectId: string) {
  return store.publishGate(projectId);
}

/* ---------------- 工具 ---------------- */
function splitConfigs(value: string) {
  return value
    .split(/[,，、|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function statusLabel(status: SharedReportVersion['status']) {
  return status === 'active' ? '有效' : status === 'superseded' ? '已换版' : '已撤回';
}

function statusColor(status: SharedReportVersion['status']) {
  return status === 'active' ? 'green' : status === 'superseded' ? 'amber' : 'red';
}

const reportGroups = computed(() => {
  const groups = new Map<string, SharedReportVersion[]>();
  for (const report of store.ledger.reports) {
    const list = groups.get(report.reportKey) ?? [];
    list.push(report);
    groups.set(report.reportKey, list);
  }
  return [...groups.values()].map((list) => list.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)));
});

const sharedStats = computed(() => ({
  reports: store.ledger.reports.length,
  active: store.ledger.reports.filter((report) => report.status === 'active').length,
  references: store.ledger.references.length,
  invalidRefs: allReferenceViews.value.filter((view) => view.staleConfigurations.length || view.uncoveredConfigurations.length).length,
  pendingBatches: store.pendingBatches().length,
  chainIssues: chainIssues.value.length
}));
</script>

<template>
  <div class="mb-6">
    <p class="text-sm font-medium text-teal-700">共享证据控制</p>
    <h1 class="mt-1 text-2xl font-semibold">共享报告引用账</h1>
    <p class="mt-2 text-sm text-slate-600">
      多个车型共用同一份电池包试验报告，每个认证项目登记引用版本与覆盖配置；源头换版/撤回后仅受影响配置的证据失效重算，其他项目仍视作有效证据。
    </p>
  </div>

  <section class="workspace-grid mb-6">
    <div class="col-span-12 sm:col-span-6 xl:col-span-3">
      <StatTile label="源头报告版本" :value="`${sharedStats.active}/${sharedStats.reports}`" note="有效 / 全部版本" />
    </div>
    <div class="col-span-12 sm:col-span-6 xl:col-span-3">
      <StatTile label="项目引用登记" :value="sharedStats.references" note="存在失效配置的登记另计" />
    </div>
    <div class="col-span-12 sm:col-span-6 xl:col-span-3">
      <StatTile label="待恢复同步批次" :value="sharedStats.pendingBatches" note="失败后保留的完整引用批次" />
    </div>
    <div class="col-span-12 sm:col-span-6 xl:col-span-3">
      <StatTile label="引用链路问题" :value="sharedStats.chainIssues" note="成环或丢失来源会停住发布" />
    </div>
  </section>

  <div v-if="message" class="mb-4 border border-green-200 bg-green-50 p-3 text-sm text-green-900">{{ message }}</div>
  <div v-if="error" class="mb-4 border border-red-200 bg-red-50 p-3 text-sm text-red-900">{{ error }}</div>

  <section class="mb-6 grid gap-6 xl:grid-cols-2">
    <div class="border border-slate-200 bg-white p-5">
      <h2 class="font-semibold">源头报告换版 / 新发版</h2>
      <p class="mt-1 text-xs text-slate-500">发布新版后同族旧版标记为已换版，引用旧版的配置证据失效重算；未覆盖配置保持有效。</p>
      <form class="mt-4 space-y-3" @submit.prevent="publish">
        <UFormGroup label="报告族（reportKey，留空则新建族）">
          <UInput v-model="publishForm.reportKey" placeholder="KEY-BAT-PACK-A" />
        </UFormGroup>
        <div class="grid gap-3 md:grid-cols-2">
          <UFormGroup label="报告名称"><UInput v-model="publishForm.familyName" /></UFormGroup>
          <UFormGroup label="新版本号"><UInput v-model="publishForm.version" /></UFormGroup>
        </div>
        <div class="grid gap-3 md:grid-cols-2">
          <UFormGroup label="法规项"><UInput v-model="publishForm.regulationId" /></UFormGroup>
          <UFormGroup label="依赖来源版本（逗号分隔，可空）"><UInput v-model="publishForm.dependsOn" placeholder="如 SR-BAT-R3" /></UFormGroup>
        </div>
        <UFormGroup label="新版覆盖配置（逗号分隔）">
          <UInput v-model="publishForm.configurations" />
        </UFormGroup>
        <UFormGroup label="说明"><UInput v-model="publishForm.note" /></UFormGroup>
        <UButton type="submit" color="primary">发布新版本并重算引用</UButton>
      </form>
    </div>

    <div class="border border-slate-200 bg-white p-5">
      <h2 class="font-semibold">项目引用登记 / 换版刷新</h2>
      <p class="mt-1 text-xs text-slate-500">项目登记引用的报告版本与覆盖配置；重新登记到新版本后失效配置恢复有效。</p>
      <form class="mt-4 space-y-3" @submit.prevent="register">
        <UFormGroup label="认证项目">
          <USelect v-model="registerForm.projectId" :options="projectOptions" />
        </UFormGroup>
        <div class="grid gap-3 md:grid-cols-2">
          <UFormGroup label="法规项"><UInput v-model="registerForm.regulationId" /></UFormGroup>
          <UFormGroup label="引用报告版本">
            <USelect v-model="registerForm.reportVersionId" :options="reportVersionOptions" />
          </UFormGroup>
        </div>
        <UFormGroup label="登记覆盖配置（逗号分隔）">
          <UInput v-model="registerForm.configurations" />
        </UFormGroup>
        <UButton type="submit" color="primary">登记 / 刷新引用</UButton>
      </form>
    </div>
  </section>

  <section class="mb-6 border border-slate-200 bg-white">
    <div class="border-b border-slate-200 px-4 py-3">
      <h2 class="font-semibold">源头共享报告版本</h2>
      <p class="mt-1 text-xs text-slate-500">同族报告即“同一份电池包试验报告”的版本谱系。</p>
    </div>
    <div class="divide-y divide-slate-200">
      <article v-for="group in reportGroups" :key="group[0].reportKey" class="p-4">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p class="font-medium">{{ group[0].familyName }} <span class="ml-2 font-mono text-xs text-slate-400">{{ group[0].reportKey }}</span></p>
          <UBadge color="gray" variant="soft">{{ group[0].regulationId }}</UBadge>
        </div>
        <div class="overflow-x-auto">
          <table class="data-table min-w-[720px]">
            <thead>
              <tr>
                <th>版本</th>
                <th>状态</th>
                <th>覆盖配置</th>
                <th>发布时间</th>
                <th>依赖</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="report in group" :key="report.id">
                <td class="font-mono text-sm">{{ report.version }} <span class="text-xs text-slate-400">{{ report.id }}</span></td>
                <td><UBadge :color="statusColor(report.status)" variant="soft">{{ statusLabel(report.status) }}</UBadge></td>
                <td class="text-sm">{{ report.configurations.join('、') }}</td>
                <td class="text-xs text-slate-500">{{ report.publishedAt.slice(0, 16).replace('T', ' ') }}</td>
                <td class="font-mono text-xs text-slate-500">{{ report.dependsOn.join('、') || '—' }}</td>
                <td>
                  <UButton
                    v-if="report.status === 'active'"
                    size="xs"
                    color="red"
                    variant="soft"
                    @click="withdraw(report)"
                  >
                    撤回
                  </UButton>
                  <span v-else class="text-xs text-slate-400">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </article>
    </div>
  </section>

  <section class="mb-6 border border-slate-200 bg-white">
    <div class="border-b border-slate-200 px-4 py-3">
      <h2 class="font-semibold">项目引用登记（报告版本 + 覆盖配置）</h2>
      <p class="mt-1 text-xs text-slate-500">一条登记对应一个认证项目；源头变更只影响该登记内的覆盖配置。</p>
    </div>
    <div class="overflow-x-auto">
      <table class="data-table min-w-[980px]">
        <thead>
          <tr>
            <th>认证项目</th>
            <th>共享报告 / 引用版本</th>
            <th>登记覆盖配置</th>
            <th>当前有效配置</th>
            <th>失效 / 超登记配置</th>
            <th>健康状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="view in allReferenceViews" :key="view.id">
            <td>
              <NuxtLink :to="`/projects/${view.projectId}`" class="font-medium text-teal-700 hover:underline">{{ view.projectId }}</NuxtLink>
              <p class="mt-1 text-xs text-slate-500">{{ projectName(view.projectId) }}</p>
            </td>
            <td>
              <p class="text-sm">{{ view.familyName }}</p>
              <p class="mt-1 font-mono text-xs text-slate-500">{{ view.reportVersionLabel }} · {{ view.id }}</p>
            </td>
            <td class="text-sm">{{ view.configurations.join('、') }}</td>
            <td class="text-sm">
              <UBadge v-if="view.validConfigurations.length" color="green" variant="soft">{{ view.validConfigurations.join('、') }}</UBadge>
              <span v-else class="text-xs text-slate-400">无</span>
            </td>
            <td class="text-sm">
              <UBadge v-if="view.staleConfigurations.length" color="red" variant="soft">失效：{{ view.staleConfigurations.join('、') }}</UBadge>
              <UBadge v-if="view.uncoveredConfigurations.length" color="amber" variant="soft">超登记：{{ view.uncoveredConfigurations.join('、') }}</UBadge>
              <span v-if="!view.staleConfigurations.length && !view.uncoveredConfigurations.length" class="text-xs text-slate-400">—</span>
            </td>
            <td>
              <UBadge
                :color="view.reportVersionLabel === '来源丢失' ? 'red' : view.staleConfigurations.length ? 'red' : view.uncoveredConfigurations.length ? 'amber' : 'green'"
                variant="soft"
              >
                {{ view.reportVersionLabel === '来源丢失' ? '来源丢失' : view.staleConfigurations.length ? '需重算' : view.uncoveredConfigurations.length ? '覆盖超界' : '有效' }}
              </UBadge>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>

  <section class="mb-6 grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(320px,2fr)]">
    <div class="border border-slate-200 bg-white">
      <div class="border-b border-slate-200 px-4 py-3">
        <h2 class="font-semibold">源账同步批次（失败恢复 / 幂等重试）</h2>
        <p class="mt-1 text-xs text-slate-500">
          以完整引用批次同步：失败时整批不落账但保留批次，可恢复重试；已应用批次重复同步直接跳过，不会反复回退。
        </p>
      </div>
      <form class="space-y-3 p-4" @submit.prevent="syncBatch">
        <label class="flex items-center gap-2 text-sm">
          <input v-model="simulateFailure" type="checkbox" class="rounded" />
          本次同步模拟源账服务失败（失败后用同一批次恢复重试）
        </label>
        <UFormGroup label="完整批次（格式：项目:法规:报告版本:配置1,配置2 | 下一条）">
          <UTextarea v-model="batchDraft.refs" :rows="3" />
        </UFormGroup>
        <UButton type="submit" color="primary">提交源账同步批次</UButton>
      </form>

      <div class="border-t border-slate-200">
        <table class="data-table min-w-[760px]">
          <thead>
            <tr>
              <th>批次</th>
              <th>同步时间</th>
              <th>引用条数</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="batch in batches" :key="batch.id">
              <td>
                <p class="font-mono text-sm">{{ batch.id }}</p>
                <p class="mt-1 text-xs text-slate-500">{{ batch.note }}</p>
                <p v-if="batch.lastError" class="mt-1 text-xs text-red-700">{{ batch.lastError }}</p>
              </td>
              <td class="text-xs text-slate-500">{{ batch.syncedAt.slice(0, 16).replace('T', ' ') }}</td>
              <td>{{ batch.references.length }}</td>
              <td>
                <UBadge :color="batch.applied ? 'green' : 'red'" variant="soft">
                  {{ batch.applied ? '已应用' : '待恢复重试' }}
                </UBadge>
              </td>
              <td>
                <div v-if="!batch.applied" class="flex flex-wrap gap-2">
                  <UButton size="xs" color="green" variant="soft" @click="retry(batch.id, false)">恢复重试（成功）</UButton>
                  <UButton size="xs" color="amber" variant="soft" @click="retry(batch.id, true)">再失败一次</UButton>
                </div>
                <UButton v-else size="xs" color="gray" variant="soft" @click="retry(batch.id, false)">重复同步（应跳过）</UButton>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="space-y-6">
      <div class="border border-slate-200 bg-white p-5">
        <h2 class="font-semibold">引用链路：成环 / 丢失来源</h2>
        <p class="mt-1 text-xs text-slate-500">检测到成环或来源丢失时列出完整链路，并停住所有受影响项目的发布。</p>
        <div class="mt-4 flex flex-wrap gap-2">
          <UButton size="sm" color="red" variant="soft" @click="inject('cycle')">注入自引用成环</UButton>
          <UButton size="sm" color="amber" variant="soft" @click="inject('missing_source')">注入来源丢失</UButton>
          <UButton size="sm" color="gray" variant="soft" @click="inject('clear')">清除问题</UButton>
        </div>
        <div v-if="chainIssues.length" class="mt-4 space-y-3">
          <div v-for="(issue, index) in chainIssues" :key="index" class="border border-red-200 bg-red-50 p-3">
            <UBadge color="red" variant="soft" class="mb-2">{{ issue.type === 'cycle' ? '引用成环' : '来源丢失' }}</UBadge>
            <p class="font-mono text-xs text-red-900">{{ issue.chain.join('  →  ') }}</p>
            <p class="mt-2 text-sm text-red-900">{{ issue.detail }}</p>
          </div>
        </div>
        <p v-else class="mt-4 text-sm text-slate-500">当前未检测到链路问题。</p>
      </div>

      <div class="border border-slate-200 bg-white p-5">
        <h2 class="font-semibold">发布闸门预览</h2>
        <p class="mt-1 text-xs text-slate-500">各项目按当前时间点计算的审批阻断结果。</p>
        <div class="mt-4 space-y-3">
          <div v-for="project in store.projects" :key="project.id" class="border border-slate-200 p-3">
            <div class="flex items-center justify-between gap-2">
              <NuxtLink :to="`/projects/${project.id}`" class="text-sm font-medium text-teal-700 hover:underline">{{ project.id }}</NuxtLink>
              <UBadge :color="gateFor(project.id)?.allowed ? 'green' : 'red'" variant="soft">
                {{ gateFor(project.id)?.allowed ? '可发布' : '发布停住' }}
              </UBadge>
            </div>
            <ul v-if="!gateFor(project.id)?.allowed" class="mt-2 list-inside list-disc space-y-1 text-xs text-red-800">
              <li v-for="issue in gateFor(project.id)?.issues.slice(0, 4)" :key="issue">{{ issue }}</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
