/**
 * 检测报告（实验室判定）数据模型
 * 合作实验室依据送检单（orderNo）出具的纸张与墨色档位检测结论；
 * 对账时按送检单号（再纸种 / 墨色档位兜底）匹配到本馆拓本并「挂一条实验室判定」。
 * 同一送检单会补发复检，以晚到的为准；找不到本馆拓本的先放待认领，不能丢。
 */
import type { InkTone } from './rubbing';

/** 对账状态：已挂上实验室判定 / 待认领（本馆暂无对应拓本） */
export type LabReportStatus = 'matched' | 'pending';

export interface LabReport {
  id: string;
  /** 送检单号：业务主键，同一送检单补发复检以晚到的为准 */
  orderNo: string;
  /** 实验室检测纸种 */
  paperType: string;
  /** 实验室检测墨色档位：浓墨 / 淡墨 */
  inkTone: InkTone;
  /** 对账状态 */
  status: LabReportStatus;
  /** 挂上的本馆拓本 id；待认领时为 null */
  matchedRubbingId: string | null;
  /** 检测日期 yyyy-MM-dd */
  reportDate: string;
  /** 检测机构 */
  lab: string;
  /** 备注（如「复检以本次为准」） */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export type LabReportDraft = Omit<LabReport, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'matchedRubbingId'>;

export const LAB_REPORT_STATUS_LABEL: Record<LabReportStatus, string> = {
  matched: '已挂上',
  pending: '待认领',
};

export const LAB_REPORT_STATUS_COLOR: Record<LabReportStatus, string> = {
  matched: '#2f6f4f',
  pending: '#c9963c',
};

export const LAB_REPORT_STATUS_OPTIONS: ReadonlyArray<{ value: LabReportStatus; label: string }> = [
  { value: 'matched', label: '已挂上' },
  { value: 'pending', label: '待认领' },
];

export function createEmptyLabReportDraft(): LabReportDraft {
  return {
    orderNo: '',
    paperType: '宣纸',
    inkTone: 'thick',
    reportDate: new Date().toISOString().slice(0, 10),
    lab: '合作纸张实验室',
    note: '',
  };
}
