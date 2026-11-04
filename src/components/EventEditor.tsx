'use client';

import { useState } from 'react';
import { Alert, App, Button, Form, Input, Modal, Select, Space } from 'antd';
import type { Entity, HubEvent, Kind } from '../shared/contracts';
import { ApiError, errorMessage, requestJson, type HubAction } from './api';
import { kindOptions, safeUrl } from './format';

interface Values { title: string; summary?: string; kind: Kind; url?: string; entity_id?: string; tags?: string[]; note?: string; published_at?: string }

export default function EventEditor({ event, entities, act, onClose }: { event?: HubEvent; entities: Entity[]; act: HubAction; onClose: () => void }) {
  const [form] = Form.useForm<Values>();
  const { modal } = App.useApp();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [baseline] = useState(event);
  const [expectedRevision, setExpectedRevision] = useState(event?.revision);
  const [conflict, setConflict] = useState<HubEvent | null>(null);
  function close() {
    if (!form.isFieldsTouched()) { onClose(); return; }
    modal.confirm({ title: '放弃尚未保存的内容？', content: '当前输入还没有保存。', okText: '放弃修改', cancelText: '继续编辑', onOk: onClose });
  }
  async function save(values: Values) {
    setPending(true); setError('');
    try {
      if (event) {
        const patch: Record<string, unknown> = {};
        const original = baseline ?? event;
        if (values.title !== original.title) patch.title = values.title;
        if ((values.summary ?? '') !== original.summary) patch.summary = values.summary ?? '';
        if (values.kind !== original.kind) patch.kind = values.kind;
        if ((values.entity_id ?? null) !== original.entity_id) patch.entity_id = values.entity_id ?? null;
        if (JSON.stringify(values.tags ?? []) !== JSON.stringify(original.tags)) patch.tags = values.tags ?? [];
        if ((values.note ?? '') !== original.personal.note) patch.personal = { note: values.note ?? '' };
        if (Object.keys(patch).length) await act({ action: 'update', id: event.id, revision: expectedRevision, patch }, '修正已保存，原始来源仍然保留');
      } else {
        await act({ action: 'create', ...values, summary: values.summary ?? '', tags: values.tags ?? [], note: values.note ?? '', published_at: values.published_at ? `${values.published_at}T00:00:00+08:00` : null, published_precision: values.published_at ? 'date' : 'unknown' }, '链接已保存');
      }
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      if (event && cause instanceof ApiError && cause.status === 409) {
        try { const latest = await requestJson<{ event: HubEvent }>(`/api/hub?id=${encodeURIComponent(event.id)}`); setConflict(latest.event); }
        catch { setError('内容已发生变化，暂时无法获取最新版本。你的输入仍然保留，请稍后重试。'); }
      }
    }
    finally { setPending(false); }
  }
  return <Modal open title={event ? '修正内容' : '添加链接'} onCancel={close} footer={null} width={720} destroyOnHidden mask={{ closable: false }}>
    <p className="muted">{event ? '修改会单独保存，后续同步不会覆盖你的整理。' : '补充值得留下的信息。保存链接不会自动开启对该网站的采集。'}</p>
    {error && <Alert type="error" showIcon title={error} className="section-alert" />}
    {conflict && <Alert type="warning" showIcon title="请对照另一处保存的最新内容" className="section-alert" description={<div><dl><dt>标题</dt><dd>{conflict.title}</dd><dt>摘要</dt><dd className="preserve-lines">{conflict.summary || '无'}</dd><dt>标签</dt><dd>{conflict.tags.join('、') || '无'}</dd><dt>私人备注</dt><dd className="preserve-lines">{conflict.personal.note || '无'}</dd></dl><p>下方表单仍是你尚未保存的输入。先合并需要保留的资料，再确认并重试。</p><Button onClick={() => { setExpectedRevision(conflict.revision); setConflict(null); setError('已选用最新修订基线，请确认下方资料后再次保存。'); }}>已核对，保留当前输入重试</Button></div>} />}
    {event && <details className="original-values"><summary>对照原始采集内容 / 恢复自动值</summary><dl><dt>原标题</dt><dd>{String(event.originals.title ?? event.title)}</dd><dt>来源摘要</dt><dd>{String(event.originals.summary ?? '来源未提供摘要')}</dd></dl><Space wrap>{Object.keys(event.overrides).filter((key) => ['title', 'summary', 'kind', 'entity_id', 'tags'].includes(key)).map((key) => <Button size="small" key={key} onClick={() => modal.confirm({ title: `恢复${({ title: '标题', summary: '摘要', kind: '分类', entity_id: '实体关联', tags: '标签' } as Record<string, string>)[key]}的自动值？`, content: '此字段会恢复为最新来源值。当前表单尚未保存的输入将放弃，已有修订历史仍会保留。', okText: '恢复自动值', cancelText: '取消', onOk: async () => { await act({ action: 'update', id: event.id, revision: expectedRevision, patch: {}, reset: [key] }, '已恢复自动值'); onClose(); } })}>恢复{({ title: '标题', summary: '摘要', kind: '分类', entity_id: '关联', tags: '标签' } as Record<string, string>)[key]}</Button>)}</Space></details>}
    <Form form={form} layout="vertical" requiredMark={false} initialValues={event ? { title: event.title, summary: event.summary, kind: event.kind, entity_id: event.entity_id ?? undefined, tags: event.tags, note: event.personal.note } : { kind: 'tool', tags: [] }} onFinish={save}>
      {!event && <Form.Item name="url" label="原文链接" rules={[{ required: true, message: '请输入原文链接' }, { validator: (_, value) => !value || safeUrl(value) ? Promise.resolve() : Promise.reject(new Error('请输入不含账号密码的 HTTP 或 HTTPS 链接')) }]}><Input placeholder="https://…" inputMode="url" /></Form.Item>}
      <Form.Item name="title" label="标题" rules={[{ required: true, whitespace: true, message: '请输入标题' }, { max: 500, message: '标题不能超过 500 个字符' }]}><Input maxLength={500} /></Form.Item>
      <div className="form-columns">
        <Form.Item name="kind" label="内容类型" rules={[{ required: true }]}><Select options={kindOptions} /></Form.Item>
        <Form.Item name="entity_id" label="关联模型或项目"><Select allowClear showSearch optionFilterProp="label" placeholder="可选" options={entities.map((entity) => ({ value: entity.id, label: entity.name }))} /></Form.Item>
      </div>
      {!event && <Form.Item name="published_at" label="发布日期" extra="可留空；只记录日期，不推测具体发布时间。"><Input type="date" /></Form.Item>}
      <Form.Item name="summary" label={event && !event.manual && !Object.hasOwn(event.overrides, 'summary') ? '来源摘要 · 修改后记为人工整理' : '摘要 · 人工整理'} rules={[{ max: 10000, message: '摘要不能超过 10,000 个字符' }]}><Input.TextArea rows={5} placeholder="概括发生了什么，保留事实依据" maxLength={10000} showCount /></Form.Item>
      <Form.Item name="tags" label="标签" rules={[{ validator: (_, values: string[] | undefined) => !values || values.every((value) => value.trim().length > 0 && value.length <= 50) ? Promise.resolve() : Promise.reject(new Error('每个标签应为 1–50 个字符')) }]}><Select mode="tags" tokenSeparators={[',', '，']} placeholder="输入标签后按回车" maxCount={30} /></Form.Item>
      <Form.Item name="note" label="私人备注" extra="备注与来源摘要分开保存，不会随公开来源默认发送到第三方。"><Input.TextArea rows={3} maxLength={20000} placeholder="为什么值得关注？你准备怎样使用它？" /></Form.Item>
      <div className="form-actions"><Button onClick={close}>取消</Button><Button type="primary" htmlType="submit" loading={pending} disabled={!!conflict}>{event ? '保存修正' : '保存链接'}</Button></div>
    </Form>
  </Modal>;
}
