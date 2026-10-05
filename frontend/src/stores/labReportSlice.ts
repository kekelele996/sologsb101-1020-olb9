/**
 * 检测报告 slice（Redux Toolkit）
 * 维护实验室检测报告与对账状态；整批导入在 Dexie 事务中完成，
 * 任一环节失败即整批回滚到贴之前的样子（已挂判定 / 待认领均不残留半成品）。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db } from '@/utils/db';
import { reconcileLabReports } from '@/utils/labReport';
import type { LabReport, LabReportDraft, LabReportStatus } from '@/types/labReport';
import type { RootState } from './store';

export interface LabReportState {
  items: LabReport[];
  loading: boolean;
  ready: boolean;
  error: string;
  statusFilter: LabReportStatus | 'all';
}

const initialState: LabReportState = {
  items: [],
  loading: false,
  ready: false,
  error: '',
  statusFilter: 'all',
};

export const loadLabReports = createAsyncThunk('labReport/load', async () => {
  const rows = await db.labReports.toArray();
  return rows.sort((a, b) => (a.reportDate < b.reportDate ? 1 : a.reportDate > b.reportDate ? -1 : b.updatedAt - a.updatedAt));
});

export interface ImportLabReportsResult {
  imported: number;
  matched: number;
  pending: number;
}

/**
 * 整批导入检测报告并对账。
 * 同一送检单以晚到的为准（复检覆盖）；匹配到本馆拓本则挂判定，否则置待认领。
 * 全部写入包在一个事务里，失败即回滚。
 */
export const importLabReports = createAsyncThunk<ImportLabReportsResult, LabReportDraft[]>(
  'labReport/importBatch',
  async (input, { dispatch, getState }) => {
    const state = getState() as RootState;
    const rubbings = state.rubbing.items;
    const existing = state.labReport.items;
    const now = Date.now();

    // 写入前校验：任一报告送检单号为空即整批拒绝（此时尚未写入，无半成品）
    for (const draft of input) {
      if (!draft.orderNo.trim()) throw new Error('送检单号不能为空，整批已回滚');
    }

    // 对账（纯函数）：内部按送检单号去重、晚到为准
    const reconciled = reconcileLabReports(input, rubbings, existing, now);

    // 事务内整批写入；任何一步抛错都会让事务中止、整批回滚
    await db.transaction('rw', [db.labReports, db.rubbings], async () => {
      await db.labReports.bulkPut(reconciled.reports);
      if (reconciled.rubbingPatches.length > 0) {
        await db.rubbings.bulkPut(reconciled.rubbingPatches);
      }
    });

    await dispatch(loadLabReports());
    return {
      imported: reconciled.reports.length,
      matched: reconciled.matchedCount,
      pending: reconciled.pendingCount,
    };
  },
);

/** 手动认领：把待认领报告挂到指定拓本（事务内同时回写送检单号） */
export const claimLabReport = createAsyncThunk(
  'labReport/claim',
  async (payload: { reportId: string; rubbingId: string }, { dispatch, getState }) => {
    const state = getState() as RootState;
    const report = state.labReport.items.find((item) => item.id === payload.reportId);
    const rubbing = state.rubbing.items.find((item) => item.id === payload.rubbingId);
    if (!report) throw new Error('未找到待认领的检测报告');
    if (!rubbing) throw new Error('未找到要挂上的拓本');
    const now = Date.now();
    await db.transaction('rw', [db.labReports, db.rubbings], async () => {
      await db.labReports.put({
        ...report,
        status: 'matched',
        matchedRubbingId: rubbing.id,
        updatedAt: now,
      });
      if (!(rubbing.labOrderNo ?? '')) {
        await db.rubbings.put({ ...rubbing, labOrderNo: report.orderNo, updatedAt: now });
      }
    });
    await dispatch(loadLabReports());
  },
);

export const removeLabReport = createAsyncThunk('labReport/remove', async (id: string, { dispatch }) => {
  await db.labReports.delete(id);
  await dispatch(loadLabReports());
});

const labReportSlice = createSlice({
  name: 'labReport',
  initialState,
  reducers: {
    setLabReportStatusFilter(state, action: PayloadAction<LabReportStatus | 'all'>) {
      state.statusFilter = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadLabReports.pending, (state) => {
        state.loading = true;
      })
      .addCase(loadLabReports.fulfilled, (state, action) => {
        state.items = action.payload;
        state.loading = false;
        state.ready = true;
        state.error = '';
      })
      .addCase(loadLabReports.rejected, (state, action) => {
        state.loading = false;
        state.ready = true;
        state.error = action.error.message ?? '检测报告读取失败';
      })
      .addCase(importLabReports.rejected, (state, action) => {
        state.error = action.error.message ?? '检测报告导入失败，整批已回滚';
      })
      .addCase(claimLabReport.rejected, (state, action) => {
        state.error = action.error.message ?? '认领失败';
      });
  },
});

export const { setLabReportStatusFilter } = labReportSlice.actions;

export const selectLabReportState = (state: RootState): LabReportState => state.labReport;
export const selectLabReports = (state: RootState): LabReport[] => state.labReport.items;

/** 派生选择器：待认领报告 */
export function selectPendingLabReports(state: RootState): LabReport[] {
  return state.labReport.items.filter((report) => report.status === 'pending');
}

/** 派生选择器：按拓本 id 查已挂上的实验室判定 */
export function selectLabReportByRubbing(state: RootState, rubbingId: string): LabReport | undefined {
  return state.labReport.items.find((report) => report.status === 'matched' && report.matchedRubbingId === rubbingId);
}

export default labReportSlice.reducer;
