/**
 * 实验室检测报告 slice（Redux Toolkit）
 * 维护实验室报告集合；整批贴入在 utils/db.ts 的单个 IndexedDB 事务内完成，失败整批回滚。
 * 报告只挂「实验室判定」，不触碰编目员填写的拓法与断代结论。
 */
import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';
import {
  claimLabReport,
  db,
  detachLabReport,
  ingestLabReports,
  removeLabReport,
  type IngestLabReportRow,
  type IngestLabReportsResult,
} from '@/utils/db';
import type { LabReport } from '@/types/labReport';
import type { RootState } from './store';

export interface LabState {
  items: LabReport[];
  loading: boolean;
  ready: boolean;
  error: string;
  /** 最近一次贴入结果（用于页面提示） */
  lastResult: IngestLabReportsResult | null;
}

const initialState: LabState = {
  items: [],
  loading: false,
  ready: false,
  error: '',
  lastResult: null,
};

export const loadLabReports = createAsyncThunk('lab/load', async () => {
  const items = await db.labReports.toArray();
  items.sort((a, b) => (a.updatedAt === b.updatedAt ? a.requestNo.localeCompare(b.requestNo) : b.updatedAt - a.updatedAt));
  return items;
});

/** 整批贴入：事务内任一写入失败即整体回滚，页面 catch 到 rejected */
export const ingestLabReportsThunk = createAsyncThunk(
  'lab/ingest',
  async (rows: IngestLabReportRow[], { dispatch }) => {
    const result = await ingestLabReports(rows);
    await dispatch(loadLabReports());
    return result;
  },
);

export const claimLabReportThunk = createAsyncThunk(
  'lab/claim',
  async (payload: { requestNo: string; rubbingId: string }, { dispatch }) => {
    await claimLabReport(payload.requestNo, payload.rubbingId);
    await dispatch(loadLabReports());
  },
);

export const detachLabReportThunk = createAsyncThunk('lab/detach', async (requestNo: string, { dispatch }) => {
  await detachLabReport(requestNo);
  await dispatch(loadLabReports());
});

export const removeLabReportThunk = createAsyncThunk('lab/remove', async (requestNo: string, { dispatch }) => {
  await removeLabReport(requestNo);
  await dispatch(loadLabReports());
});

const labSlice = createSlice({
  name: 'lab',
  initialState,
  reducers: {
    clearLabError(state) {
      state.error = '';
    },
    clearLastIngestResult(state) {
      state.lastResult = null;
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
      .addCase(ingestLabReportsThunk.pending, (state) => {
        state.loading = true;
        state.error = '';
      })
      .addCase(ingestLabReportsThunk.fulfilled, (state, action) => {
        state.loading = false;
        state.lastResult = action.payload;
      })
      .addCase(ingestLabReportsThunk.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message ?? '检测报告贴入失败，整批已回滚';
      });
  },
});

export const { clearLabError, clearLastIngestResult } = labSlice.actions;

export const selectLabState = (state: RootState): LabState => state.lab;
export const selectLabReports = (state: RootState): LabReport[] => state.lab.items;
export const selectLabLoading = (state: RootState): boolean => state.lab.loading;
export const selectLabError = (state: RootState): string => state.lab.error;
export const selectPendingLabReports = (state: RootState): LabReport[] =>
  state.lab.items.filter((item) => item.rubbingId === null);

export default labSlice.reducer;
