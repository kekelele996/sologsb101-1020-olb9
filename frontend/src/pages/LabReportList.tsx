/**
 * /lab 检测报告对账
 * 录入 / 批量导入合作实验室的检测报告：先送检单号，再纸种与墨色档位兜底匹配，
 * 对上本馆拓本就挂一条实验室判定，找不到的先放待认领（不丢）；
 * 同一送检单补发复检以晚到的为准；整批写入失败回滚到贴之前的样子。
 * 消费 LabReport、Rubbing、Stele；复用 <FilterBar>、<StatBadge>、<EmptyPanel>。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CloudUploadOutlined,
  ExperimentOutlined,
  LinkOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import FilterBar, { useFilterQuery, type FilterSelectConfig } from '@/components/common/FilterBar';
import StatBadge from '@/components/common/StatBadge';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectSteles } from '@/stores/steleSlice';
import { selectRubbings } from '@/stores/rubbingSlice';
import {
  claimLabReport,
  importLabReports,
  removeLabReport,
  selectLabReports,
  type ImportLabReportsResult,
} from '@/stores/labReportSlice';
import {
  INK_TONE_LABEL,
  PAPER_TYPE_OPTIONS,
  type InkTone,
  type Rubbing,
} from '@/types/rubbing';
import {
  LAB_REPORT_STATUS_COLOR,
  LAB_REPORT_STATUS_LABEL,
  LAB_REPORT_STATUS_OPTIONS,
  createEmptyLabReportDraft,
  type LabReport,
  type LabReportDraft,
  type LabReportStatus,
} from '@/types/labReport';

const FILTER_KEYS = ['status'] as const;

/** 批量导入示例：送检单号 + 纸种 + 墨色档位 */
const SAMPLE_JSON = `[
  { "orderNo": "SJ-2026-003", "paperType": "宣纸", "inkTone": "thick", "reportDate": "2026-09-12", "lab": "合作纸张实验室", "note": "" },
  { "orderNo": "SJ-2026-004", "paperType": "皮纸", "inkTone": "light", "reportDate": "2026-09-15", "lab": "合作纸张实验室", "note": "" }
]`;

export default function LabReportList() {
  const { message } = AntdApp.useApp();
  const dispatch = useAppDispatch();
  const [form] = Form.useForm<LabReportDraft>();

  const steles = useAppSelector(selectSteles);
  const rubbings = useAppSelector(selectRubbings);
  const reports = useAppSelector(selectLabReports);

  const url = useFilterQuery(FILTER_KEYS);
  const [open, setOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchText, setBatchText] = useState('');
  const [claiming, setClaiming] = useState<LabReport | null>(null);
  const [claimRubbingId, setClaimRubbingId] = useState<string>('');

  const selects: FilterSelectConfig[] = useMemo(
    () => [
      {
        key: 'status',
        label: '对账状态',
        options: LAB_REPORT_STATUS_OPTIONS.map((item) => ({ value: item.value, label: item.label })),
        multiple: false,
      },
    ],
    [],
  );

  const statusFilter = (url.values.status?.[0] ?? 'all') as LabReportStatus | 'all';

  const filtered = useMemo(() => {
    const keyword = url.keyword.trim();
    return reports.filter((report) => {
      if (statusFilter !== 'all' && report.status !== statusFilter) return false;
      if (keyword.length > 0) {
        const haystack = `${report.orderNo}${report.paperType}${report.lab}${report.note}`;
        if (!haystack.includes(keyword)) return false;
      }
      return true;
    });
  }, [reports, statusFilter, url.keyword]);

  const stat = useMemo(
    () => ({
      total: reports.length,
      matched: reports.filter((report) => report.status === 'matched').length,
      pending: reports.filter((report) => report.status === 'pending').length,
      recheck: reports.filter((report) => report.updatedAt - report.createdAt > 60000).length,
    }),
    [reports],
  );

  const steleTitle = (steleId: string): string => steles.find((stele) => stele.id === steleId)?.title ?? steleId;
  const rubbingLabel = (rubbing: Rubbing): string => `${steleTitle(rubbing.steleId)} · 第 ${rubbing.versionNo} 版（收藏号 ${rubbing.collectionNo || '未编'}）`;

  const openCreate = (): void => {
    form.setFieldsValue(createEmptyLabReportDraft());
    setOpen(true);
  };

  const submitSingle = async (): Promise<void> => {
    const values = await form.validateFields();
    const result = await dispatch(importLabReports([values])).unwrap();
    reportResult(result);
    setOpen(false);
  };

  const submitBatch = async (): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(batchText);
    } catch {
      message.error('JSON 解析失败，请确认是检测报告数组');
      return;
    }
    if (!Array.isArray(parsed)) {
      message.error('批量导入内容必须是检测报告数组');
      return;
    }
    const drafts: LabReportDraft[] = [];
    for (const item of parsed as unknown[]) {
      if (typeof item !== 'object' || item === null) {
        message.error('数组中存在非法条目，整批未写入');
        return;
      }
      const row = item as Record<string, unknown>;
      if (typeof row.orderNo !== 'string' || row.orderNo.trim() === '') {
        message.error('存在缺少送检单号的报告，整批未写入');
        return;
      }
      drafts.push({
        orderNo: row.orderNo.trim(),
        paperType: typeof row.paperType === 'string' && row.paperType ? row.paperType : '宣纸',
        inkTone: row.inkTone === 'light' ? 'light' : 'thick',
        reportDate: typeof row.reportDate === 'string' && row.reportDate ? row.reportDate : new Date().toISOString().slice(0, 10),
        lab: typeof row.lab === 'string' && row.lab ? row.lab : '合作纸张实验室',
        note: typeof row.note === 'string' ? row.note : '',
      });
    }
    if (drafts.length === 0) {
      message.warning('没有可导入的检测报告');
      return;
    }
    const result = await dispatch(importLabReports(drafts)).unwrap();
    reportResult(result);
    setBatchOpen(false);
    setBatchText('');
  };

  const reportResult = (result: ImportLabReportsResult): void => {
    message.success(`已导入 ${result.imported} 份：挂上 ${result.matched} 份，待认领 ${result.pending} 份`);
  };

  const openClaim = (report: LabReport): void => {
    setClaiming(report);
    setClaimRubbingId('');
  };

  const submitClaim = async (): Promise<void> => {
    if (!claiming || !claimRubbingId) {
      message.warning('请选择要挂上的拓本');
      return;
    }
    await dispatch(claimLabReport({ reportId: claiming.id, rubbingId: claimRubbingId })).unwrap();
    message.success(`已把送检单 ${claiming.orderNo} 的实验室判定挂到拓本`);
    setClaiming(null);
  };

  const columns: ColumnsType<LabReport> = [
    {
      title: '送检单号',
      dataIndex: 'orderNo',
      width: 150,
      render: (value: string, record) => (
        <Space size={4} wrap>
          <Tag color="#2f3a34">{value}</Tag>
          {record.updatedAt - record.createdAt > 60000 ? <Tag color="gold">复检覆盖</Tag> : null}
        </Space>
      ),
    },
    { title: '纸种', dataIndex: 'paperType', width: 110 },
    {
      title: '墨色档位',
      dataIndex: 'inkTone',
      width: 100,
      render: (value: InkTone) => INK_TONE_LABEL[value],
    },
    {
      title: '对账状态',
      dataIndex: 'status',
      width: 100,
      render: (value: LabReportStatus) => <Tag color={LAB_REPORT_STATUS_COLOR[value]}>{LAB_REPORT_STATUS_LABEL[value]}</Tag>,
    },
    {
      title: '对应拓本',
      dataIndex: 'matchedRubbingId',
      render: (value: string | null) => {
        if (!value) return <Typography.Text type="secondary">待认领</Typography.Text>;
        const rubbing = rubbings.find((item) => item.id === value);
        return rubbing ? rubbingLabel(rubbing) : '已删除';
      },
    },
    { title: '检测日期', dataIndex: 'reportDate', width: 120, sorter: (a, b) => a.reportDate.localeCompare(b.reportDate) },
    { title: '检测机构', dataIndex: 'lab', width: 140, render: (value: string) => value || '未填' },
    {
      title: '操作',
      key: 'action',
      width: 160,
      render: (_value, record) => (
        <Space size={4}>
          {record.status === 'pending' ? (
            <Button size="small" type="link" icon={<LinkOutlined />} onClick={() => openClaim(record)}>
              认领
            </Button>
          ) : null}
          <Popconfirm
            title="删除该检测报告"
            description="删除后已挂的实验室判定会一并移除，拓本恢复未送检。"
            okText="确认"
            cancelText="取消"
            onConfirm={async () => {
              await dispatch(removeLabReport(record.id)).unwrap();
              message.success('已删除检测报告');
            }}
          >
            <Button size="small" type="link" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>检测报告对账</h2>
          <p>
            接入合作实验室检测报告：先按送检单号对账，再按纸种与墨色档位兜底匹配；对上拓本就挂一条实验室判定，
            编目员填的拓法与断代结论不动。复检以晚到为准，找不到拓本的先放待认领。
          </p>
        </div>
        <Space wrap>
          <Button icon={<CloudUploadOutlined />} onClick={() => setBatchOpen(true)}>
            批量导入
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            录入检测报告
          </Button>
        </Space>
      </div>

      <Alert
        type="info"
        showIcon
        icon={<ExperimentOutlined />}
        style={{ marginBottom: 14 }}
        message="对账与回滚规则"
        description="同一送检单补发复检时以晚到的为准；送检单号在本馆找不到拓本的先置「待认领」，不会丢失。整批写入在一个事务内完成，任一报告非法或写入失败即整批回滚到贴之前的样子。"
      />

      <div className="gb-stat-row">
        <StatBadge label="检测报告" value={stat.total} suffix="份" tone="primary" />
        <StatBadge label="已挂上" value={stat.matched} suffix="份" tone="success" />
        <StatBadge label="待认领" value={stat.pending} suffix="份" tone="warning" />
        <StatBadge label="复检覆盖" value={stat.recheck} suffix="份" tone="info" />
      </div>

      <FilterBar
        keyword={url.keyword}
        onKeywordChange={url.setKeyword}
        selects={selects}
        values={url.values}
        onValuesChange={url.setValues}
        onReset={() => {
          url.reset();
        }}
        keywordPlaceholder="搜索送检单号 / 纸种 / 检测机构…"
        actions={<Typography.Text type="secondary">共 {filtered.length} / {reports.length} 份</Typography.Text>}
      />

      <Card className="gb-table-card" style={{ marginTop: 16 }} styles={{ body: { padding: 0 } }}>
        {filtered.length === 0 ? (
          <EmptyPanel
            title={reports.length === 0 ? '还没有检测报告' : '当前筛选条件下没有报告'}
            description={
              reports.length === 0
                ? '录入或批量导入合作实验室的检测报告，系统会按送检单号自动对账挂判定。'
                : '试着调整对账状态或关键字条件。'
            }
            actionText="录入检测报告"
            onAction={openCreate}
            secondaryText="批量导入"
            onSecondary={() => setBatchOpen(true)}
            size="small"
          />
        ) : (
          <Table<LabReport>
            rowKey="id"
            size="small"
            pagination={{ pageSize: 8 }}
            columns={columns}
            dataSource={filtered}
          />
        )}
      </Card>

      {/* 单份录入 */}
      <Modal
        open={open}
        title="录入检测报告"
        onCancel={() => setOpen(false)}
        onOk={() => void submitSingle()}
        okText="写入并对账"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="orderNo" label="送检单号" rules={[{ required: true, message: '请填写送检单号' }]}>
            <Input placeholder="如：SJ-2026-003" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="paperType" label="纸种" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={PAPER_TYPE_OPTIONS.map((item) => ({ value: item, label: item }))} />
            </Form.Item>
            <Form.Item name="inkTone" label="墨色档位" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select
                options={[
                  { value: 'thick', label: '浓墨' },
                  { value: 'light', label: '淡墨' },
                ]}
              />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="reportDate" label="检测日期" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="date" />
            </Form.Item>
            <Form.Item name="lab" label="检测机构" style={{ flex: 1 }}>
              <Input placeholder="如：合作纸张实验室" />
            </Form.Item>
          </Space>
          <Form.Item name="note" label="备注">
            <Input placeholder="如：复检以本次为准" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 批量导入 */}
      <Modal
        open={batchOpen}
        title="批量导入检测报告"
        onCancel={() => setBatchOpen(false)}
        onOk={() => void submitBatch()}
        okText="整批写入并对账"
        cancelText="取消"
        width={640}
        destroyOnClose
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
          粘贴检测报告 JSON 数组，字段含送检单号、纸种、墨色档位（thick/light）、检测日期、检测机构与备注。
          整批在一个事务内写入，任一条非法即整批回滚。
        </Typography.Paragraph>
        <Input.TextArea
          value={batchText}
          onChange={(event) => setBatchText(event.target.value)}
          placeholder={SAMPLE_JSON}
          rows={10}
          style={{ fontFamily: 'monospace', fontSize: 12 }}
        />
        <Space style={{ marginTop: 8 }}>
          <Button size="small" onClick={() => setBatchText(SAMPLE_JSON)}>
            填入示例
          </Button>
        </Space>
      </Modal>

      {/* 手动认领 */}
      <Modal
        open={!!claiming}
        title={`认领检测报告 · ${claiming?.orderNo ?? ''}`}
        onCancel={() => setClaiming(null)}
        onOk={() => void submitClaim()}
        okText="挂上判定"
        cancelText="取消"
        destroyOnClose
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
          送检单 {claiming?.orderNo}（{claiming?.paperType} · {claiming ? INK_TONE_LABEL[claiming.inkTone] : ''}
          ）在本馆未找到对应拓本，请指定要挂上的拓本。
        </Typography.Paragraph>
        <Select
          style={{ width: '100%' }}
          placeholder="选择本馆拓本"
          value={claimRubbingId || undefined}
          options={rubbings.map((rubbing) => ({ value: rubbing.id, label: rubbingLabel(rubbing) }))}
          onChange={(value: string) => setClaimRubbingId(value)}
        />
      </Modal>
    </div>
  );
}
