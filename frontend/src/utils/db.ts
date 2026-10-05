/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑（v1 → v2：Loss 增加 charNo 与复合索引，并按行号顺序重建历史字位记录；
 *   v2 → v3：新增 labReports 实验室检测报告表）
 * - 六张业务表的增删改查与整库导入导出
 * - 首次打开自动播种三层互相引用的演示数据（幂等）
 * 纯前端应用：不依赖任何后端服务或数据库。
 */
import Dexie, { type Table } from 'dexie';
import type { Stele } from '@/types/stele';
import type { Rubbing } from '@/types/rubbing';
import type { Loss } from '@/types/loss';
import type { Seal } from '@/types/seal';
import type { Compare } from '@/types/compare';
import type { LabReport } from '@/types/labReport';
import { matchLabReport, validateLabReportInput, type LabReportInput } from './labMatch';
import { sortLosses } from './collate';

/** 数据库名（README 与导出文件均使用该名称） */
export const DB_NAME = 'gbrubbing';

/** 当前数据结构版本号 */
export const DB_SCHEMA_VERSION = 3;

/** localStorage 侧少量元数据键 */
export const LS_KEYS = {
  dbVersion: 'gbrubbing:db-version',
  lastBackupAt: 'gbrubbing:last-backup-at',
  uiPrefs: 'gbrubbing:ui-prefs',
} as const;

export interface UiPrefs {
  lastSteleId: string | null;
  lastRubbingId: string | null;
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastSteleId: null, lastRubbingId: null };

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs);
    if (!raw) return { ...DEFAULT_UI_PREFS };
    const parsed = JSON.parse(raw) as Partial<UiPrefs>;
    return {
      lastSteleId: typeof parsed.lastSteleId === 'string' ? parsed.lastSteleId : null,
      lastRubbingId: typeof parsed.lastRubbingId === 'string' ? parsed.lastRubbingId : null,
    };
  } catch {
    return { ...DEFAULT_UI_PREFS };
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  try {
    localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_SCHEMA_VERSION));
  } catch {
    /* ignore */
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt);
  } catch {
    return null;
  }
}

export function writeLastBackupAt(value: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, value);
  } catch {
    /* ignore */
  }
}

class RubbingDatabase extends Dexie {
  steles!: Table<Stele, string>;
  rubbings!: Table<Rubbing, string>;
  losses!: Table<Loss, string>;
  seals!: Table<Seal, string>;
  compares!: Table<Compare, string>;
  labReports!: Table<LabReport, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（历史字位记录仅有 lineNo）
    this.version(1).stores({
      steles: 'id, title, era, form, updatedAt',
      rubbings: 'id, steleId, versionNo, method, state, updatedAt',
      losses: 'id, rubbingId, lineNo, type, severity, updatedAt',
      seals: 'id, rubbingId, sealType, updatedAt',
      compares: 'id, steleId, rubbingIdA, rubbingIdB, conclusion, updatedAt',
    });

    // v2：Loss 增加 charNo 与 [rubbingId+lineNo+charNo] 复合索引，并按行号顺序重建历史字位记录
    this.version(2)
      .stores({
        steles: 'id, title, era, form, location, updatedAt',
        rubbings: 'id, steleId, versionNo, method, inkTone, state, updatedAt',
        losses: 'id, rubbingId, lineNo, charNo, [rubbingId+lineNo+charNo], type, severity, updatedAt',
        seals: 'id, rubbingId, sealType, position, updatedAt',
        compares: 'id, steleId, rubbingIdA, rubbingIdB, conclusion, date, updatedAt',
      })
      .upgrade(async (tx) => {
        const table = tx.table<Loss>('losses');
        const all = await table.toArray();
        const byRubbing = new Map<string, Loss[]>();
        all.forEach((loss) => {
          byRubbing.set(loss.rubbingId, [...(byRubbing.get(loss.rubbingId) ?? []), loss]);
        });
        const rebuilt: Loss[] = [];
        byRubbing.forEach((list) => {
          // 按行号排序后，为缺失 charNo 的历史记录在行内顺序补位
          const sorted = [...list].sort((a, b) => a.lineNo - b.lineNo);
          const counter = new Map<number, number>();
          sorted.forEach((loss) => {
            const used = counter.get(loss.lineNo) ?? 0;
            const charNo = typeof loss.charNo === 'number' && loss.charNo > 0 ? loss.charNo : used + 1;
            counter.set(loss.lineNo, Math.max(used, charNo));
            rebuilt.push({ ...loss, charNo, updatedAt: Date.now() });
          });
        });
        await table.bulkPut(sortLosses(rebuilt));
      });

    // v3：新增实验室检测报告表（送检单号主键，rubbingId 挂接拓本；null 为待认领）
    this.version(DB_SCHEMA_VERSION).stores({
      steles: 'id, title, era, form, location, updatedAt',
      rubbings: 'id, steleId, versionNo, method, inkTone, state, updatedAt',
      losses: 'id, rubbingId, lineNo, charNo, [rubbingId+lineNo+charNo], type, severity, updatedAt',
      seals: 'id, rubbingId, sealType, position, updatedAt',
      compares: 'id, steleId, rubbingIdA, rubbingIdB, conclusion, date, updatedAt',
      labReports: 'requestNo, rubbingId, matchMode, inkGrade, updatedAt',
    });
  }
}

export const db = new RubbingDatabase();

/** 生成主键：短前缀 + 时间戳 + 随机串 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** 打开数据库并在首次使用时播种演示数据（幂等） */
export async function initDatabase(): Promise<void> {
  await db.open();
  stampDbVersion();
  if ((await db.steles.count()) === 0) {
    await seedDatabase();
  }
}

/* ------------------------------ 播种数据 ------------------------------ */
/* 三层互相引用：Stele → Rubbing →（Loss / Seal）＋ Stele → Compare */

export async function seedDatabase(): Promise<void> {
  const now = Date.now();
  const day = 86400000;

  const steles: Stele[] = [
    {
      id: 'stele_01',
      title: '礼器碑',
      era: '东汉永寿二年',
      location: '山东曲阜孔庙',
      form: 'stele',
      sizeCm: '227×93',
      calligrapher: '佚名（隶书）',
      createdAt: now - day * 60,
      updatedAt: now - day * 3,
    },
    {
      id: 'stele_02',
      title: '石门颂',
      era: '东汉建和二年',
      location: '陕西汉中石门',
      form: 'cliff',
      sizeCm: '261×205',
      calligrapher: '王升（隶书）',
      createdAt: now - day * 48,
      updatedAt: now - day * 2,
    },
    {
      id: 'stele_03',
      title: '颜勤礼碑',
      era: '唐大历十四年',
      location: '陕西西安碑林',
      form: 'stele',
      sizeCm: '268×92',
      calligrapher: '颜真卿（楷书）',
      createdAt: now - day * 36,
      updatedAt: now - day,
    },
  ];

  const rubbings: Rubbing[] = [
    { id: 'rub_0101', steleId: 'stele_01', versionNo: 1, method: 'rub', paperType: '宣纸', inkTone: 'thick', sizeCm: '210×88', collectionNo: 'TB-0101', dateGuess: '明拓', state: 'cataloged', createdAt: now - day * 50, updatedAt: now - day * 10 },
    { id: 'rub_0102', steleId: 'stele_01', versionNo: 2, method: 'cicada', paperType: '棉连纸', inkTone: 'light', sizeCm: '208×86', collectionNo: 'TB-0102', dateGuess: '清拓', state: 'toCompare', createdAt: now - day * 44, updatedAt: now - day * 6 },
    { id: 'rub_0201', steleId: 'stele_02', versionNo: 1, method: 'pat', paperType: '皮纸', inkTone: 'thick', sizeCm: '250×196', collectionNo: 'TB-0201', dateGuess: '清中期拓', state: 'cataloged', createdAt: now - day * 40, updatedAt: now - day * 5 },
    { id: 'rub_0202', steleId: 'stele_02', versionNo: 2, method: 'rub', paperType: '棉连纸', inkTone: 'light', sizeCm: '248×194', collectionNo: 'TB-0202', dateGuess: '清晚期拓', state: 'toCatalog', createdAt: now - day * 34, updatedAt: now - day * 4 },
    { id: 'rub_0301', steleId: 'stele_03', versionNo: 1, method: 'rub', paperType: '净皮宣', inkTone: 'thick', sizeCm: '260×90', collectionNo: 'TB-0301', dateGuess: '民国拓', state: 'toCatalog', createdAt: now - day * 20, updatedAt: now - day * 2 },
  ];

  const losses: Loss[] = [
    { id: 'loss_010101', rubbingId: 'rub_0101', lineNo: 3, charNo: 7, type: 'blur', severity: 'light', note: '「壽」字右下漫漶', createdAt: now - day * 30, updatedAt: now - day * 30 },
    { id: 'loss_010102', rubbingId: 'rub_0101', lineNo: 5, charNo: 2, type: 'stoneFlower', severity: 'medium', note: '石花漫及「年」字', createdAt: now - day * 30, updatedAt: now - day * 29 },
    { id: 'loss_010103', rubbingId: 'rub_0101', lineNo: 9, charNo: 11, type: 'missing', severity: 'heavy', note: '「禮」字缺末笔', createdAt: now - day * 28, updatedAt: now - day * 28 },
    { id: 'loss_010201', rubbingId: 'rub_0102', lineNo: 3, charNo: 7, type: 'blur', severity: 'medium', note: '晚拓，「壽」字已损', createdAt: now - day * 24, updatedAt: now - day * 24 },
    { id: 'loss_010202', rubbingId: 'rub_0102', lineNo: 9, charNo: 11, type: 'missing', severity: 'heavy', note: '「禮」字全缺', createdAt: now - day * 24, updatedAt: now - day * 22 },
    { id: 'loss_010203', rubbingId: 'rub_0102', lineNo: 12, charNo: 4, type: 'crack', severity: 'medium', note: '碑面斜裂一道', createdAt: now - day * 22, updatedAt: now - day * 22 },
    { id: 'loss_020101', rubbingId: 'rub_0201', lineNo: 2, charNo: 5, type: 'crack', severity: 'light', note: '崖面细裂', createdAt: now - day * 18, updatedAt: now - day * 18 },
    { id: 'loss_020201', rubbingId: 'rub_0202', lineNo: 2, charNo: 5, type: 'crack', severity: 'light', note: '崖面细裂（同前）', createdAt: now - day * 20, updatedAt: now - day * 20 },
    { id: 'loss_020202', rubbingId: 'rub_0202', lineNo: 6, charNo: 3, type: 'blur', severity: 'medium', note: '晚拓，「頌」字已漫漶', createdAt: now - day * 18, updatedAt: now - day * 18 },
    { id: 'loss_030101', rubbingId: 'rub_0301', lineNo: 4, charNo: 3, type: 'blur', severity: 'heavy', note: '民国拓，字口已平', createdAt: now - day * 10, updatedAt: now - day * 10 },
  ];

  const seals: Seal[] = [
    { id: 'seal_0101', rubbingId: 'rub_0101', sealText: '端方藏碑', position: '右下角', transcription: '端方（匋斋）收藏印', sealType: 'collection', createdAt: now - day * 40, updatedAt: now - day * 40 },
    { id: 'seal_0102', rubbingId: 'rub_0101', sealText: '匋斋鉴赏', position: '左下角', transcription: '端方鉴赏印', sealType: 'appraisal', createdAt: now - day * 40, updatedAt: now - day * 40 },
    { id: 'seal_0103', rubbingId: 'rub_0102', sealText: '艺风堂', position: '卷尾', transcription: '缪荃孙艺风堂藏书印', sealType: 'collection', createdAt: now - day * 30, updatedAt: now - day * 30 },
    { id: 'seal_0201', rubbingId: 'rub_0201', sealText: '石门旧拓', position: '左上角', transcription: '藏家自钤印', sealType: 'author', createdAt: now - day * 26, updatedAt: now - day * 26 },
  ];

  const compares: Compare[] = [
    { id: 'cmp_0101', steleId: 'stele_01', rubbingIdA: 'rub_0101', rubbingIdB: 'rub_0102', diffCount: 3, conclusion: 'early', operator: '傅砚', date: '2026-03-06', createdAt: now - day * 5, updatedAt: now - day * 5 },
    { id: 'cmp_0201', steleId: 'stele_02', rubbingIdA: 'rub_0201', rubbingIdB: 'rub_0202', diffCount: 1, conclusion: 'late', operator: '傅砚', date: '2026-03-08', createdAt: now - day * 3, updatedAt: now - day * 3 },
  ];

  // 实验室检测报告：① 送检单号即收藏号 TB-0101；② 单号查无、纸种墨色唯一（皮纸/浓墨 → rub_0201）；
  // ③ 单号查无且棉连纸/淡墨有 rub_0102、rub_0202 两件同档 → 待认领
  const labReports: LabReport[] = [
    {
      requestNo: 'TB-0101',
      paperType: '宣纸',
      inkGrade: 'thick',
      verdict: '明代棉料宣，墨色沉稳，与明中期拓本特征相符',
      reportDate: '2026-03-12',
      rubbingId: 'rub_0101',
      matchMode: 'requestNo',
      round: 1,
      createdAt: now - day * 4,
      updatedAt: now - day * 4,
    },
    {
      requestNo: 'LAB-2026-0002',
      paperType: '皮纸',
      inkGrade: 'thick',
      verdict: '陕地构皮纸，纤维粗长，建议清中期以前',
      reportDate: '2026-03-15',
      rubbingId: 'rub_0201',
      matchMode: 'paperInk',
      round: 1,
      createdAt: now - day * 2,
      updatedAt: now - day * 2,
    },
    {
      requestNo: 'LAB-2026-0003',
      paperType: '棉连纸',
      inkGrade: 'light',
      verdict: '棉连纸淡墨，需编目员结合损泐确认具体拓本',
      reportDate: '2026-03-16',
      rubbingId: null,
      matchMode: null,
      round: 1,
      createdAt: now - day * 1,
      updatedAt: now - day * 1,
    },
  ];

  await db.transaction('rw', [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.labReports], async () => {
    await db.steles.bulkPut(steles);
    await db.rubbings.bulkPut(rubbings);
    await db.losses.bulkPut(losses);
    await db.seals.bulkPut(seals);
    await db.compares.bulkPut(compares);
    await db.labReports.bulkPut(labReports);
  });
}

/* ------------------------------ 整库导入导出 ------------------------------ */

export interface RubbingSnapshot {
  app: typeof DB_NAME;
  schemaVersion: number;
  exportedAt: string;
  steles: Stele[];
  rubbings: Rubbing[];
  losses: Loss[];
  seals: Seal[];
  compares: Compare[];
  /** v3 起存在；旧备份导入时按缺省空数组处理 */
  labReports?: LabReport[];
}

export async function exportSnapshot(): Promise<RubbingSnapshot> {
  const [steles, rubbings, losses, seals, compares, labReports] = await Promise.all([
    db.steles.toArray(),
    db.rubbings.toArray(),
    db.losses.toArray(),
    db.seals.toArray(),
    db.compares.toArray(),
    db.labReports.toArray(),
  ]);
  return {
    app: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    steles,
    rubbings,
    losses,
    seals,
    compares,
    labReports,
  };
}

/** 校验导入文件结构，返回错误文案（空串表示通过） */
export function validateSnapshot(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '文件内容不是合法的 JSON 对象';
  const snapshot = input as Partial<RubbingSnapshot>;
  if (snapshot.app !== DB_NAME) return `备份文件不属于本项目（app=${String(snapshot.app)}）`;
  const keys: Array<keyof RubbingSnapshot> = ['steles', 'rubbings', 'losses', 'seals', 'compares'];
  for (const key of keys) {
    if (!Array.isArray(snapshot[key])) return `备份文件缺少 ${String(key)} 集合`;
  }
  return '';
}

export async function clearAllTables(): Promise<void> {
  await db.transaction('rw', [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.labReports], async () => {
    await Promise.all([
      db.steles.clear(),
      db.rubbings.clear(),
      db.losses.clear(),
      db.seals.clear(),
      db.compares.clear(),
      db.labReports.clear(),
    ]);
  });
}

export async function importSnapshot(snapshot: RubbingSnapshot): Promise<void> {
  await clearAllTables();
  await db.transaction('rw', [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.labReports], async () => {
    await db.steles.bulkPut(snapshot.steles);
    await db.rubbings.bulkPut(snapshot.rubbings);
    await db.losses.bulkPut(snapshot.losses);
    await db.seals.bulkPut(snapshot.seals);
    await db.compares.bulkPut(snapshot.compares);
    // 兼容 v2 旧备份（无检测报告集合）
    if (Array.isArray(snapshot.labReports)) await db.labReports.bulkPut(snapshot.labReports);
  });
}

export async function resetDatabase(): Promise<void> {
  await clearAllTables();
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [steles, rubbings, losses, seals, compares, labReports] = await Promise.all([
    db.steles.count(),
    db.rubbings.count(),
    db.losses.count(),
    db.seals.count(),
    db.compares.count(),
    db.labReports.count(),
  ]);
  return { steles, rubbings, losses, seals, compares, labReports };
}

/** 级联删除碑刻 → 拓本 → 损泐 / 钤印 / 比对；挂在拓本上的检测报告回到待认领（不丢单） */
export async function removeSteleCascade(steleId: string): Promise<void> {
  const rubbingIds = (await db.rubbings.where('steleId').equals(steleId).toArray()).map((row) => row.id);
  await db.transaction('rw', [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.labReports], async () => {
    if (rubbingIds.length > 0) {
      await db.losses.where('rubbingId').anyOf(rubbingIds).delete();
      await db.seals.where('rubbingId').anyOf(rubbingIds).delete();
      const now = Date.now();
      const detached = (await db.labReports.where('rubbingId').anyOf(rubbingIds).toArray()).map((row) => ({
        ...row,
        rubbingId: null,
        matchMode: null,
        updatedAt: now,
      }));
      if (detached.length > 0) await db.labReports.bulkPut(detached);
    }
    await db.rubbings.where('steleId').equals(steleId).delete();
    await db.compares.where('steleId').equals(steleId).delete();
    await db.steles.delete(steleId);
  });
}

/** 级联删除拓本 → 损泐 / 钤印 / 涉及的比对记录；其实验室报告回到待认领 */
export async function removeRubbingCascade(rubbingId: string): Promise<void> {
  await db.transaction('rw', [db.rubbings, db.losses, db.seals, db.compares, db.labReports], async () => {
    await db.losses.where('rubbingId').equals(rubbingId).delete();
    await db.seals.where('rubbingId').equals(rubbingId).delete();
    const compares = await db.compares.toArray();
    const affected = compares.filter((row) => row.rubbingIdA === rubbingId || row.rubbingIdB === rubbingId);
    if (affected.length > 0) await db.compares.bulkDelete(affected.map((row) => row.id));
    const now = Date.now();
    const detached = (await db.labReports.where('rubbingId').equals(rubbingId).toArray()).map((row) => ({
      ...row,
      rubbingId: null,
      matchMode: null,
      updatedAt: now,
    }));
    if (detached.length > 0) await db.labReports.bulkPut(detached);
    await db.rubbings.delete(rubbingId);
  });
}

/** 重排某碑刻下拓本的版本序号，保证连续 */
export async function renumberRubbings(steleId: string): Promise<void> {
  const rows = await db.rubbings.where('steleId').equals(steleId).toArray();
  const sorted = [...rows].sort((a, b) => (a.versionNo === b.versionNo ? a.createdAt - b.createdAt : a.versionNo - b.versionNo));
  await db.rubbings.bulkPut(sorted.map((row, index) => ({ ...row, versionNo: index + 1, updatedAt: Date.now() })));
}

/* ------------------------------ 实验室检测报告 ------------------------------ */

export interface IngestLabReportRow extends LabReportInput {}

export interface IngestLabReportsResult {
  /** 本次写入（含复检覆盖）的送检单条数 */
  written: number;
  /** 其中复检覆盖条数 */
  rechecked: number;
  /** 新挂上拓本的条数 */
  matched: number;
  /** 待认领条数（不会丢） */
  pending: number;
  rows: LabReport[];
}

/**
 * 整批贴入实验室检测报告。
 * - 同批内送检单号去重，晚到的一条为准；库内已有同单号时按复检覆盖（round +1）并沿用原挂接。
 * - 匹配顺序：先送检单号，再纸种和墨色档位；对不上的 rubbingId=null 待认领。
 * - 全部写入在单个事务内完成，任一失败整批回滚到贴之前的样子（拓本等其余表不受影响）。
 */
export async function ingestLabReports(inputs: IngestLabReportRow[]): Promise<IngestLabReportsResult> {
  const clean: LabReportInput[] = [];
  inputs.forEach((input) => {
    const row: LabReportInput = {
      requestNo: input.requestNo.trim(),
      paperType: input.paperType.trim(),
      inkGrade: input.inkGrade,
      verdict: input.verdict.trim(),
      reportDate: input.reportDate?.trim() ?? '',
    };
    const invalid = validateLabReportInput(row);
    if (invalid) throw new Error(`送检单 ${input.requestNo || '（空）'}：${invalid}`);
    // 同批内相同送检单号：保留后出现的（晚到为准）
    const existingIndex = clean.findIndex((item) => item.requestNo === row.requestNo);
    if (existingIndex >= 0) clean[existingIndex] = row;
    else clean.push(row);
  });

  const result: IngestLabReportsResult = { written: 0, rechecked: 0, matched: 0, pending: 0, rows: [] };

  await db.transaction('rw', [db.labReports, db.rubbings], async () => {
    const [rubbings, stored] = await Promise.all([db.rubbings.toArray(), db.labReports.toArray()]);
    const storedByNo = new Map(stored.map((row) => [row.requestNo, row]));
    const now = Date.now();
    const toPut: LabReport[] = clean.map((input) => {
      const previous = storedByNo.get(input.requestNo);
      const match = matchLabReport(input, rubbings, previous);
      const isRecheck = previous !== undefined;
      const row: LabReport = {
        requestNo: input.requestNo,
        paperType: input.paperType,
        inkGrade: input.inkGrade,
        verdict: input.verdict,
        reportDate: input.reportDate ?? '',
        rubbingId: match.rubbingId,
        matchMode: match.matchMode,
        round: isRecheck ? previous.round + 1 : 1,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      result.written += 1;
      if (isRecheck) result.rechecked += 1;
      if (match.rubbingId) result.matched += 1;
      else result.pending += 1;
      result.rows.push(row);
      return row;
    });
    await db.labReports.bulkPut(toPut);
  });

  return result;
}

/** 人工把待认领报告挂到某件拓本 */
export async function claimLabReport(requestNo: string, rubbingId: string): Promise<void> {
  await db.transaction('rw', [db.labReports, db.rubbings], async () => {
    const report = await db.labReports.get(requestNo);
    if (!report) throw new Error(`送检单 ${requestNo} 不存在`);
    const rubbing = await db.rubbings.get(rubbingId);
    if (!rubbing) throw new Error('所选拓本不存在');
    await db.labReports.put({ ...report, rubbingId, matchMode: 'manual', updatedAt: Date.now() });
  });
}

/** 摘掉挂接，报告退回待认领（不删除） */
export async function detachLabReport(requestNo: string): Promise<void> {
  await db.labReports.update(requestNo, { rubbingId: null, matchMode: null, updatedAt: Date.now() });
}

export async function removeLabReport(requestNo: string): Promise<void> {
  await db.labReports.delete(requestNo);
}
