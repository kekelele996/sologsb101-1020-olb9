/**
 * 检测报告对账工具
 * - 同一送检单补发复检：按送检单号去重，晚到的覆盖先到的（以晚到的为准）
 * - 对账顺序：先按送检单号（rubbing.labOrderNo）匹配，再按纸种 + 墨色档位兜底匹配
 * - 匹配到本馆拓本则「挂一条实验室判定」（status=matched 并回写拓本送检单号）；
 *   找不到则置为待认领（status=pending），记录保留不丢
 * 全部为纯函数，实际写入由 slice 在 Dexie 事务中完成（失败整批回滚）。
 */
import type { LabReport, LabReportDraft } from '@/types/labReport';
import type { Rubbing } from '@/types/rubbing';
import { createId } from './db';

/** 同一送检单：晚到的覆盖先到的 */
export function dedupeReportsByOrderNo(input: LabReportDraft[]): LabReportDraft[] {
  const map = new Map<string, LabReportDraft>();
  input.forEach((draft) => {
    const orderNo = draft.orderNo.trim();
    if (!orderNo) return;
    map.set(orderNo, { ...draft, orderNo });
  });
  return Array.from(map.values());
}

export interface ReconcileResult {
  /** 对账后的检测报告（含复用复检 id 的覆盖行） */
  reports: LabReport[];
  /** 需要回写送检单号的拓本（仅当原先未登记送检单号） */
  rubbingPatches: Rubbing[];
  matchedCount: number;
  pendingCount: number;
}

/**
 * 把一批检测报告与本馆拓本对账，输出待写入的报告与拓本补丁。
 * @param input 待导入的报告草稿（内部会按送检单号去重，晚到为准）
 * @param rubbings 本馆现有拓本
 * @param existing 本馆已挂的检测报告（复检覆盖时复用 id）
 */
export function reconcileLabReports(
  input: LabReportDraft[],
  rubbings: Rubbing[],
  existing: LabReport[],
  now: number,
): ReconcileResult {
  const drafts = dedupeReportsByOrderNo(input);
  const existingByOrderNo = new Map<string, LabReport>();
  existing.forEach((report) => existingByOrderNo.set(report.orderNo, report));

  // 已有实验室判定的拓本，兜底匹配时优先跳过，避免一份拓本挂多条判定
  const alreadyMatchedRubbingIds = new Set(
    existing.filter((report) => report.status === 'matched' && report.matchedRubbingId).map((report) => report.matchedRubbingId as string),
  );

  const reports: LabReport[] = [];
  const rubbingPatches: Rubbing[] = [];
  const patchedRubbingIds = new Set<string>();

  drafts.forEach((draft) => {
    const orderNo = draft.orderNo;
    if (!orderNo) throw new Error('送检单号不能为空');

    // 第一步：按送检单号在本馆拓本中找
    let rubbing = rubbings.find((item) => (item.labOrderNo ?? '') === orderNo);
    // 第二步：按纸种 + 墨色档位兜底匹配（优先尚未挂过判定的拓本）
    if (!rubbing) {
      rubbing =
        rubbings.find(
          (item) =>
            !alreadyMatchedRubbingIds.has(item.id) &&
            item.paperType === draft.paperType &&
            item.inkTone === draft.inkTone,
        ) ??
        rubbings.find((item) => item.paperType === draft.paperType && item.inkTone === draft.inkTone);
    }

    const matched = Boolean(rubbing);
    const prev = existingByOrderNo.get(orderNo);
    const report: LabReport = {
      id: prev?.id ?? createId('lab'),
      orderNo,
      paperType: draft.paperType,
      inkTone: draft.inkTone,
      status: matched ? 'matched' : 'pending',
      matchedRubbingId: matched ? (rubbing as Rubbing).id : null,
      reportDate: draft.reportDate,
      lab: draft.lab,
      note: draft.note,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    reports.push(report);

    if (matched && rubbing && !(rubbing.labOrderNo ?? '') && !patchedRubbingIds.has(rubbing.id)) {
      rubbingPatches.push({ ...rubbing, labOrderNo: orderNo, updatedAt: now });
      patchedRubbingIds.add(rubbing.id);
      alreadyMatchedRubbingIds.add(rubbing.id);
    }
  });

  return {
    reports,
    rubbingPatches,
    matchedCount: reports.filter((report) => report.status === 'matched').length,
    pendingCount: reports.filter((report) => report.status === 'pending').length,
  };
}
