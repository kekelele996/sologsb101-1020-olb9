/**
 * 实验室检测报告（LabReport）数据模型
 * 合作实验室出具的纸张与墨色检测报告：先按送检单号、再按纸种与墨色档位挂接到拓本；
 * 挂接后只作为「实验室判定」附在拓本旁，不改动编目员填写的拓法与断代结论。
 * 同一送检单补发复检时以晚到的报告为准（同主键覆盖，round 递增）；
 * 在本馆找不到拓本时 rubbingId 置空，进入待认领，不丢单。
 */
import type { InkTone } from './rubbing';

/** 挂接方式：按送检单号沿用 / 按纸种墨色匹配 / 人工认领 */
export type LabMatchMode = 'requestNo' | 'paperInk' | 'manual';

export interface LabReport {
  /** 送检单号（主键，同一单号只保留晚到的一条） */
  requestNo: string;
  /** 实验室认定的纸种 */
  paperType: string;
  /** 墨色档位：浓墨 / 淡墨 */
  inkGrade: InkTone;
  /** 实验室判定结论（纸张、墨色、断代辅助意见） */
  verdict: string;
  /** 报告日期 yyyy-MM-dd，实验室未填时为空串 */
  reportDate: string;
  /** 挂接到的拓本 id；null 表示待认领 */
  rubbingId: string | null;
  /** 本条记录的挂接方式；待认领时为 null */
  matchMode: LabMatchMode | null;
  /** 收检轮次：1 初检，2 起为补发复检（同一送检单每覆盖一次 +1） */
  round: number;
  createdAt: number;
  updatedAt: number;
}

export const LAB_MATCH_MODE_LABEL: Record<LabMatchMode, string> = {
  requestNo: '按送检单号',
  paperInk: '按纸种墨色',
  manual: '人工认领',
};

/** 轮次文案：初检 / 第 N 次复检 */
export function labRoundLabel(round: number): string {
  return round <= 1 ? '初检' : `第 ${round - 1} 次复检`;
}
