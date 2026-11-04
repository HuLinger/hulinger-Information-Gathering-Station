'use client';

import { useRef, useState } from 'react';
import { Alert, Button, Checkbox, Divider, Form, Input, InputNumber, Modal, Select, Space, Tag } from 'antd';
import type { HubData, HubEvent, Personal } from '../shared/contracts';
import type { EventDetailData, SourceRecord } from './EventDetail';
import { errorMessage, postJson, requestJson, type HubAction } from './api';
import { stringValue } from './format';

interface MergePreview { events: HubEvent[]; records: SourceRecord[]; conflicts: string[] }
interface MergeValues { title: string; summary: string; tags: string[]; note: string; favorite: boolean; later: boolean; read: boolean; archived: boolean }
const blankPersonal = (): Personal => ({ favorite: false, later: false, read: false, archived: false, note: '' });

export function MergeDialog({ initialIds, candidates, act, onClose }: { initialIds: string[]; candidates: HubEvent[]; act: HubAction; onClose: () => void }) {
  const [ids, setIds] = useState(initialIds);
  const [options, setOptions] = useState(candidates.map((event) => ({ value: event.id, label: event.title })));
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [form] = Form.useForm<MergeValues>();
  const searchSequence = useRef(0);
  async function search(value: string) {
    const sequence = ++searchSequence.current;
    try {
      const data = await requestJson<HubData>(`/api/hub?view=search&q=${encodeURIComponent(value)}`);
      if (sequence === searchSequence.current) setOptions((current) => [...new Map([...current, ...data.events.filter((event) => event.status === 'active' || event.status === 'review').map((event) => ({ value: event.id, label: event.title }))].map((option) => [option.value, option])).values()]);
    } catch (cause) { setError(errorMessage(cause)); }
  }
  async function previewMerge() {
    setPending(true); setError('');
    try {
      const next = await postJson<MergePreview>('/api/hub', { action: 'mergePreview', ids });
      setPreview(next);
      form.setFieldsValue({
        title: next.events[0].title, summary: next.events[0].summary,
        tags: [...new Set(next.events.flatMap((event) => event.tags))],
        note: [...new Set(next.events.map((event) => event.personal.note).filter(Boolean))].join('\n\n'),
        favorite: next.events.some((event) => event.personal.favorite), later: next.events.some((event) => event.personal.later),
        read: next.events.every((event) => event.personal.read), archived: next.events.every((event) => event.personal.archived),
      });
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  }
  async function merge(values: MergeValues) {
    if (!preview) return;
    setPending(true); setError('');
    try {
      await act({ action: 'merge', ids, revisions: Object.fromEntries(preview.events.map((event) => [event.id, event.revision])), title: values.title, summary: values.summary, tags: values.tags, personal: { favorite: values.favorite, later: values.later, read: values.read, archived: values.archived, note: values.note } }, '事件已合并，原始关系已保留');
      onClose();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  }
  return <Modal open title="合并相同事件" width={760} footer={null} onCancel={onClose} mask={{ closable: false }}>
    <p className="muted">只有描述同一事实的条目才应合并。不同版本、价格变化或停用应保留为独立事件。</p>
    {error && <Alert type="error" showIcon title={error} className="section-alert" />}
    <label className="field-label" htmlFor="merge-candidates">选择待合并事件</label>
    <Select id="merge-candidates" mode="multiple" value={ids} className="full-width" placeholder="输入标题查找并选择至少两条事件" options={options} filterOption={false} onSearch={(value) => void search(value)} onChange={(next) => { setIds(next); setPreview(null); }} />
    <Button className="section-top" onClick={() => void previewMerge()} loading={pending} disabled={ids.length < 2}>预览合并影响</Button>
    {preview && <>
      <Divider />
      <div className="merge-preview"><h3>将合并 {preview.events.length} 条事件、保留 {preview.records.length} 条来源记录</h3>{preview.events.map((event) => <div key={event.id}><strong>{event.title}</strong><p className="muted">{event.source_name} · 修订 {event.revision}</p></div>)}</div>
      {preview.conflicts.length > 0 && <Alert type="warning" showIcon title="存在需要确认的差异" description={preview.conflicts.join('、')} className="section-alert" />}
      <Form form={form} layout="vertical" onFinish={merge} requiredMark={false}>
        <Form.Item name="title" label="合并后标题" rules={[{ required: true, whitespace: true }]}><Input maxLength={500} /></Form.Item>
        <Form.Item name="summary" label="合并后摘要"><Input.TextArea rows={4} maxLength={10000} /></Form.Item>
        <Form.Item name="tags" label="保留标签"><Select mode="tags" /></Form.Item>
        <Form.Item name="note" label="合并备注 · 保留全部原备注"><Input.TextArea rows={4} readOnly /></Form.Item>
        <div className="checkbox-fields"><Form.Item name="favorite" valuePropName="checked"><Checkbox>收藏</Checkbox></Form.Item><Form.Item name="later" valuePropName="checked"><Checkbox>稍后读</Checkbox></Form.Item><Form.Item name="read" valuePropName="checked"><Checkbox>已读</Checkbox></Form.Item><Form.Item name="archived" valuePropName="checked"><Checkbox>归档</Checkbox></Form.Item></div>
        <Alert type="info" showIcon title="合并不会丢弃来源与修订记录，可在详情中撤销。" className="section-alert" />
        <div className="form-actions"><Button onClick={onClose}>取消</Button><Button htmlType="submit" type="primary" loading={pending}>确认合并</Button></div>
      </Form>
    </>}
  </Modal>;
}

interface SplitGroup { title: string; recordIds: string[]; tags: string[]; personal: Personal }

export function SplitDialog({ detail, act, onClose }: { detail: EventDetailData; act: HubAction; onClose: () => void }) {
  const { event, records } = detail;
  const [groups, setGroups] = useState<SplitGroup[]>([
    { title: event.title, recordIds: records.slice(0, 1).map((record) => record.id), tags: event.tags, personal: { ...event.personal } },
    { title: stringValue(records[1]?.data.title, event.title), recordIds: records.slice(1).map((record) => record.id), tags: [], personal: blankPersonal() },
  ]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  function update(index: number, patch: Partial<SplitGroup>) { setGroups((old) => old.map((group, i) => i === index ? { ...group, ...patch } : group)); setConfirmed(false); }
  async function split() {
    setPending(true); setError('');
    try {
      await act({ action: 'split', id: event.id, revision: event.revision, groups }, '来源已拆分，已记录禁止自动重新合并的关系');
      onClose();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  }
  return <Modal open title="拆分来源记录" width={780} footer={null} onCancel={onClose} mask={{ closable: false }}>
    <p className="muted">把不同事件的来源分别归组，并确认个人整理的归属。每条来源只能分配一次。</p>
    {error && <Alert type="error" showIcon title={error} className="section-alert" />}
    <Space wrap><label htmlFor="split-count">拆分为</label><InputNumber id="split-count" min={2} max={records.length} value={groups.length} onChange={(value) => { if (value && value !== groups.length) { setGroups((old) => Array.from({ length: value }, (_, index) => old[index] ?? { title: '', recordIds: [], tags: [], personal: blankPersonal() })); setConfirmed(false); } }} /><span>条事件</span></Space>
    <div className="record-assignment">{records.map((record) => <div key={record.id}><span>{stringValue(record.data.title, '来源记录')}</span><Select aria-label={`分配来源 ${stringValue(record.data.title, record.id)}`} placeholder="未分配" value={groups.some((group) => group.recordIds.includes(record.id)) ? groups.findIndex((group) => group.recordIds.includes(record.id)) : undefined} options={groups.map((_, index) => ({ value: index, label: `事件 ${index + 1}` }))} onChange={(index) => { setGroups((old) => old.map((group, i) => ({ ...group, recordIds: i === index ? [...new Set([...group.recordIds, record.id])] : group.recordIds.filter((id) => id !== record.id) }))); setConfirmed(false); }} /></div>)}</div>
    {groups.map((group, index) => <section className="split-group" key={index}>
      <h3>事件 {index + 1} <Tag>{group.recordIds.length} 条来源</Tag></h3>
      <label className="field-label" htmlFor={`split-title-${index}`}>标题</label><Input id={`split-title-${index}`} value={group.title} maxLength={500} onChange={(change) => update(index, { title: change.target.value })} />
      <label className="field-label" htmlFor={`split-tags-${index}`}>标签</label><Select id={`split-tags-${index}`} mode="tags" className="full-width" value={group.tags} onChange={(tags) => update(index, { tags })} />
      <label className="field-label" htmlFor={`split-note-${index}`}>归属备注</label><Input.TextArea id={`split-note-${index}`} rows={3} value={group.personal.note} onChange={(change) => update(index, { personal: { ...group.personal, note: change.target.value } })} />
      <Space wrap className="section-top">{(['favorite', 'later', 'read', 'archived'] as const).map((key) => <Checkbox key={key} checked={group.personal[key]} onChange={(change) => update(index, { personal: { ...group.personal, [key]: change.target.checked } })}>{({ favorite: '收藏', later: '稍后读', read: '已读', archived: '归档' })[key]}</Checkbox>)}</Space>
    </section>)}
    <Checkbox checked={confirmed} onChange={(change) => setConfirmed(change.target.checked)}>我已核对所有来源和个人整理的归属</Checkbox>
    <div className="form-actions"><Button onClick={onClose}>取消</Button><Button type="primary" disabled={!confirmed || groups.some((group) => !group.title.trim() || !group.recordIds.length) || groups.flatMap((group) => group.recordIds).length !== records.length} loading={pending} onClick={() => void split()}>确认拆分</Button></div>
  </Modal>;
}
