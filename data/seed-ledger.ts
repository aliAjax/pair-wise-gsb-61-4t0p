import type { LedgerState, SharedReportVersion } from '~/types/certification';

/**
 * 共享报告源头账种子：
 * 同一份动力电池包安全试验报告（KEY-BAT-PACK-A）被
 * TA-2026-118（纯电运动轿车，两个配置）和 TA-2026-120（城市物流电动货车）共用。
 */
export const BATTERY_REPORT_KEY = 'KEY-BAT-PACK-A';

export const batteryReportVersions: SharedReportVersion[] = [
  {
    id: 'SR-BAT-R3',
    reportKey: BATTERY_REPORT_KEY,
    familyName: '动力电池包安全测试报告',
    regulationId: 'REG-BATTERY',
    version: 'R3',
    configurations: ['长续航四驱版', '标准续航后驱版'],
    status: 'superseded',
    supersededById: 'SR-BAT-R4',
    dependsOn: [],
    publishedAt: '2026-08-12T02:00:00.000Z',
    note: '早期电池包试验版本，仅覆盖轿车平台两配置。'
  },
  {
    id: 'SR-BAT-R4',
    reportKey: BATTERY_REPORT_KEY,
    familyName: '动力电池包安全测试报告',
    regulationId: 'REG-BATTERY',
    version: 'R4',
    configurations: ['长续航四驱版', '标准续航后驱版', '标准厢式版'],
    status: 'active',
    dependsOn: [],
    publishedAt: '2026-09-19T08:00:00.000Z',
    note: '换版后扩展覆盖物流车标准厢式版，同包多车型共用。'
  }
];

export function seedLedger(): LedgerState {
  return {
    reports: structuredClone(batteryReportVersions),
    references: [
      {
        id: 'RR-118-BAT',
        projectId: 'TA-2026-118',
        regulationId: 'REG-BATTERY',
        reportVersionId: 'SR-BAT-R4',
        reportKey: BATTERY_REPORT_KEY,
        configurations: ['长续航四驱版', '标准续航后驱版'],
        registeredAt: '2026-09-19T09:00:00.000Z',
        invalidatedConfigurations: []
      },
      {
        id: 'RR-120-BAT',
        projectId: 'TA-2026-120',
        regulationId: 'REG-BATTERY',
        reportVersionId: 'SR-BAT-R4',
        reportKey: BATTERY_REPORT_KEY,
        configurations: ['标准厢式版'],
        registeredAt: '2026-09-27T12:40:00.000Z',
        invalidatedConfigurations: []
      }
    ],
    batches: [
      {
        id: 'BAT-SEED-01',
        syncedAt: '2026-09-27T12:40:00.000Z',
        references: [
          {
            projectId: 'TA-2026-118',
            regulationId: 'REG-BATTERY',
            reportVersionId: 'SR-BAT-R4',
            reportKey: BATTERY_REPORT_KEY,
            configurations: ['长续航四驱版', '标准续航后驱版']
          },
          {
            projectId: 'TA-2026-120',
            regulationId: 'REG-BATTERY',
            reportVersionId: 'SR-BAT-R4',
            reportKey: BATTERY_REPORT_KEY,
            configurations: ['标准厢式版']
          }
        ],
        applied: true,
        note: '源账初始完整引用批次：电池包 R4 一次同步到两个车型项目。'
      }
    ]
  };
}
