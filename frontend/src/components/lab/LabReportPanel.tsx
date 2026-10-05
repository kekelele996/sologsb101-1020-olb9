/**
 * 实验室检测报告面板
 * 贴入实验室对账单（送检单号、纸种、墨色档位、实验室判定）：
 * - 整批在单个 IndexedDB 事务内写入，任一失败整批回滚到贴之前的样子；
 * - 同一送检单补发复检时以晚到的为准（round 递增）；
 * - 对不上本馆拓本的报告留在「待认领」，不丢单，可人工认领。
 * 实验室判定只挂接展示，不改动编目员填写的拓法与断代结论。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Badge,
  Button,
  Drawer,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { ExperimentOutlined, LinkOutlined, DisconnectOutlined, DeleteOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectSteles } from '@/stores/steleSlice';
import { selectRubbings } from '@/stores/rubbingSlice';
import {
  claimLabReportThunk,
  detachLabReportThunk,
  ingestLabReportsThunk,
  removeLabReportThunk,
  selectLabReports,
  selectPendingLabReports,
} from '@/stores/labSlice';
import { INK_TONE_LABEL } from '@/types/rubbing';
import { LAB_MATCH_MODE_LABEL, labRoundLabel, type LabReport } from '@/types/labReport';
import { parseLabReportsText } from '@/utils/labMatch';

export interface LabReportPanelProps {
  open: boolean;
  onClose: () => void;
}

const PLACEHOLDER = ['送检单号\t纸种\t墨色档位\t实验室判定\t报告日期', 'LAB-2026-0007\t皮纸\t浓墨\t纤维粗长，建议清中期以前\t2026-10-01'].join('\n');

export function LabReportPanel({ open, onClose }: LabReportPanelProps) {
  const { message } = AntdApp.useApp();
  const dispatch = useAppDispatch();
  const steles = useAppSelector(selectSteles);
  const rubbings = useAppSelector(selectRubbings);
  const reports = useAppSelector(selectLabReports);
  const pending = useAppSelector(selectPendingLabReports);

  const [text, setText] = useState('');
  const [claimTargets, setClaimTargets] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<'all' | 'pending'>('all');

  const steleTitle = (steleId: string): string => steles.find((stele) => stele.id === steleId)?.title ?? steleId;

  const rubbingLabel = (id: string): string => {
    const rubbing = rubbings.find((item) => item.id === id);
    return rubbing ? `${steleTitle(rubbing.steleId)} · 第 ${rubbing.versionNo} 版（${rubbing.collectionNo || '未编收藏号'}）` : '拓本已删除';
  };

  const rubbingOptions = useMemo(
    () =>
      steles.map((stele) => ({
        label: stele.title,
        options: rubbings
          .filter((rubbing) => rubbing.steleId === stele.id)
          .map((rubbing) => ({
            value: rubbing.id,
            label: `第 ${rubbing.versionNo} 版 · ${rubbing.paperType} · ${INK_TONE_LABEL[rubbing.inkTone]}（${rubbing.collectionNo || '未编收藏号'}）`,
          })),
      })),
    [rubbings, steles],
  );

  const submit = async (): Promise<void> => {
    const { rows, errors } = parseLabReportsText(text);
    if (errors.length > 0) {
      message.error({ content: `有 ${errors.length} 行无法识别，未写入任何数据`, duration: 6 });
      return;
    }
    if (rows.length === 0) {
      message.warning('请先贴入检测报告内容');
      return;
    }
    try {
      const result = await dispatch(ingestLabReportsThunk(rows)).unwrap();
      message.success(
        `已贴入 ${result.written} 条（复检覆盖 ${result.rechecked} 条）：挂接 ${result.matched} 条，待认领 ${result.pending} 条`,
      );
      setText('');
      if (result.pending > 0) setTab('pending');
    } catch (error) {
      message.error(`写入失败，整批已回滚到贴之前的样子：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  const claim = async (requestNo: string): Promise<void> => {
    const rubbingId = claimTargets[requestNo];
    if (!rubbingId) {
      message.warning('请先选择要认领的拓本');
      return;
    }
    await dispatch(claimLabReportThunk({ requestNo, rubbingId })).unwrap();
    message.success('已挂到该拓本');
    setClaimTargets((prev) => {
      const next = { ...prev };
      delete next[requestNo];
      return next;
    });
  };

  const columns: ColumnsType<LabReport> = [
    {
      title: '送检单号',
      dataIndex: 'requestNo',
      width: 150,
      render: (value: string, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{value}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {labRoundLabel(record.round)}
            {record.reportDate ? ` · ${record.reportDate}` : ''}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '纸种 / 墨色档位',
      key: 'paperInk',
      width: 140,
      render: (_value, record) => (
        <Space size={4} wrap>
          <Tag>{record.paperType}</Tag>
          <Tag color="gold">{INK_TONE_LABEL[record.inkGrade]}</Tag>
        </Space>
      ),
    },
    { title: '实验室判定', dataIndex: 'verdict', render: (value: string) => value || '—' },
    {
      title: '挂接拓本',
      key: 'rubbing',
      width: 240,
      render: (_value, record) =>
        record.rubbingId ? (
          <Space direction="vertical" size={2}>
            <Space size={4}>
              <Tag color="#2f6f4f">{rubbingLabel(record.rubbingId)}</Tag>
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {record.matchMode ? LAB_MATCH_MODE_LABEL[record.matchMode] : ''}
            </Typography.Text>
          </Space>
        ) : (
          <Space>
            <Tag color="warning">待认领</Tag>
            <Select
              size="small"
              style={{ minWidth: 200 }}
              showSearch
              placeholder="选择本馆拓本"
              options={rubbingOptions}
              value={claimTargets[record.requestNo]}
              onChange={(value: string) => setClaimTargets((prev) => ({ ...prev, [record.requestNo]: value }))}
              optionFilterProp="label"
            />
            <Button size="small" type="link" icon={<LinkOutlined />} onClick={() => void claim(record.requestNo)}>
              认领
            </Button>
          </Space>
        ),
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_value, record) => (
        <Space size={2} direction="vertical">
          {record.rubbingId ? (
            <Button
              size="small"
              type="link"
              icon={<DisconnectOutlined />}
              onClick={() =>
                void dispatch(detachLabReportThunk(record.requestNo))
                  .unwrap()
                  .then(() => message.success('已摘除，报告回到待认领'))
              }
            >
              摘除
            </Button>
          ) : null}
          <Popconfirm
            title="删除该检测报告"
            description="送检单记录将从本地删除，不可恢复。"
            okText="确认"
            cancelText="取消"
            onConfirm={() =>
              void dispatch(removeLabReportThunk(record.requestNo))
                .unwrap()
                .then(() => message.success('已删除'))
            }
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Drawer
      title={
        <Space>
          <ExperimentOutlined />
          <span>实验室检测报告</span>
          <Badge count={pending.length} showZero color="#c9963c" title="待认领送检单数" />
        </Space>
      }
      open={open}
      onClose={onClose}
      width={1080}
      destroyOnClose
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="贴入实验室对账单"
        description="每行一条：送检单号、纸种、墨色档位（浓墨/淡墨）、实验室判定、报告日期（可缺省），用制表符或逗号分隔。先按送检单号挂接，对不上再按纸种和墨色档位匹配；仍对不上的进待认领。同一送检单以晚到的复检为准。写入失败会整批回滚。"
      />

      <textarea
        className="gb-lab-textarea"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={PLACEHOLDER}
        rows={5}
        spellCheck={false}
      />

      <Space style={{ margin: '8px 0 16px' }}>
        <Button type="primary" onClick={() => void submit()}>
          整批贴入
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          编目员填写的拓法与断代结论不会被改动
        </Typography.Text>
      </Space>

      <Segmented
        value={tab}
        onChange={(value) => setTab(value as 'all' | 'pending')}
        options={[
          { label: `全部报告（${reports.length}）`, value: 'all' },
          { label: `待认领（${pending.length}）`, value: 'pending' },
        ]}
      />
      <Table<LabReport>
        rowKey="requestNo"
        size="small"
        pagination={{ pageSize: 8 }}
        columns={columns}
        dataSource={tab === 'pending' ? pending : reports}
      />
    </Drawer>
  );
}

export default LabReportPanel;
