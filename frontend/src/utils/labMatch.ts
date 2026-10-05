/**
 * 检测报告挂接规则（纯函数）
 * 顺序：先送检单号，再纸种和墨色档位；对不上就待认领，绝不丢单。
 */
import type { LabReport } from '@/types/labReport';
import type { Rubbing } from '@/types/rubbing';

/** 一份贴入的实验室报告：送检单号 + 纸种 + 墨色档位 + 实验室判定（报告日期可缺省） */
export interface LabReportInput {
  requestNo: string;
  paperType: string;
  inkGrade: LabReport['inkGrade'];
  verdict: string;
  reportDate?: string;
}

export interface LabMatchResult {
  /** 挂接到的拓本 id；null 表示待认领 */
  rubbingId: string | null;
  matchMode: LabReport['matchMode'];
  /** 待认领 / 歧义原因，供导入后提示 */
  reason: string;
}

/** 归一化纸种，容忍空白差异 */
function normalizePaper(value: string): string {
  return value.trim().replace(/\s+/g, '');
}

/**
 * 先按送检单号找拓本：送检单号与拓本收藏号一致即视为对上。
 * 复检（已有同送检单报告）时沿用原挂接，以晚到报告为准。
 * 单号在本馆找不到拓本时返回 null（再交由纸种墨色兜底），不抛错。
 */
function matchByRequestNo(
  input: LabReportInput,
  rubbings: Rubbing[],
  previous: LabReport | undefined,
): LabMatchResult {
  const key = input.requestNo.trim();
  const direct = rubbings.find((rubbing) => rubbing.collectionNo.trim() === key);
  if (direct) return { rubbingId: direct.id, matchMode: 'requestNo', reason: '' };

  // 复检：此前已经挂过且拓本仍在，沿用挂接；拓本已删则继续走纸种墨色兜底
  if (previous && previous.rubbingId) {
    const stillExists = rubbings.some((rubbing) => rubbing.id === previous.rubbingId);
    if (stillExists) {
      return { rubbingId: previous.rubbingId, matchMode: previous.matchMode ?? 'requestNo', reason: '' };
    }
  }

  return { rubbingId: null, matchMode: null, reason: '送检单号在本馆找不到拓本' };
}

/**
 * 再按纸种和墨色档位匹配：
 * 恰好一件则挂接；多于一件（无法判定是哪件）或一件都没有时待认领。
 * 复检沿用原挂接失败时，纸种墨色也作为兜底。
 */
export function matchLabReport(input: LabReportInput, rubbings: Rubbing[], previous?: LabReport): LabMatchResult {
  const byNo = matchByRequestNo(input, rubbings, previous);
  if (byNo.rubbingId) return byNo;

  const paper = normalizePaper(input.paperType);
  const candidates = rubbings.filter(
    (rubbing) => normalizePaper(rubbing.paperType) === paper && rubbing.inkTone === input.inkGrade,
  );
  if (candidates.length === 1) {
    return { rubbingId: candidates[0].id, matchMode: 'paperInk', reason: byNo.reason };
  }
  if (candidates.length > 1) {
    return { rubbingId: null, matchMode: null, reason: `${byNo.reason}；纸种墨色同档拓本 ${candidates.length} 件，无法判定` };
  }
  return { rubbingId: null, matchMode: null, reason: `${byNo.reason}；纸种墨色也对不上` };
}

/** 贴入前的最小校验，返回错误文案（空串表示通过） */
export function validateLabReportInput(input: Partial<LabReportInput>): string {
  if (!input.requestNo || input.requestNo.trim() === '') return '送检单号不能为空';
  if (!input.paperType || input.paperType.trim() === '') return '纸种不能为空';
  if (input.inkGrade !== 'thick' && input.inkGrade !== 'light') return '墨色档位不合法';
  return '';
}

/** 识别墨色档位：浓墨 / 淡墨（也容忍枚举原值） */
export function parseInkGrade(text: string): LabReport['inkGrade'] | null {
  const value = text.trim();
  if (value === '浓墨' || value === 'thick') return 'thick';
  if (value === '淡墨' || value === 'light') return 'light';
  return null;
}

export interface ParsedLabBatch {
  rows: LabReportInput[];
  /** 逐行错误文案（含行号） */
  errors: string[];
}

/**
 * 解析实验室贴入文本：每行一条，制表符 / 逗号分隔，列序：
 * 送检单号、纸种、墨色档位（浓墨/淡墨）、实验室判定、报告日期（可缺省）。
 * 首行若是表头（含「送检单号」）自动跳过；空行忽略。
 */
export function parseLabReportsText(text: string): ParsedLabBatch {
  const rows: LabReportInput[] = [];
  const errors: string[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === '') return;
    const lineNo = index + 1;
    if (lineNo === 1 && line.includes('送检单号')) return;
    const cells = line.split(/[\t,，]/).map((cell) => cell.trim());
    if (cells.length < 4) {
      errors.push(`第 ${lineNo} 行：至少需要「送检单号、纸种、墨色档位、实验室判定」四列`);
      return;
    }
    const [requestNo, paperType, inkText, verdict, reportDate] = cells;
    const inkGrade = parseInkGrade(inkText);
    if (!inkGrade) {
      errors.push(`第 ${lineNo} 行：墨色档位「${inkText}」无法识别（应为浓墨 / 淡墨）`);
      return;
    }
    const row: LabReportInput = { requestNo, paperType, inkGrade, verdict };
    if (reportDate) row.reportDate = reportDate;
    const invalid = validateLabReportInput(row);
    if (invalid) {
      errors.push(`第 ${lineNo} 行：${invalid}`);
      return;
    }
    rows.push(row);
  });
  return { rows, errors };
}
