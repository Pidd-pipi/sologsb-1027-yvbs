import { useMemo, useRef } from 'react';
import { Button, Callout, Card, Elevation, HTMLTable, Icon, Tag, TextArea } from '@blueprintjs/core';
import type { ConflictChoice, ExperimentProcess, MergeConflict, PeerDraft, PendingMerge } from '../lib/types';
import { deriveReviewState } from '../lib/derive';

interface MergeCenterProps {
  process: ExperimentProcess;
  peers: PeerDraft[];
  pendingMerges: PendingMerge[];
  failMode: boolean;
  lastMergeError: string | null;
  onToggleFailMode: (value: boolean) => void;
  onMergePeer: (peer: PeerDraft) => void;
  onImportRemote: (raw: string) => void;
  onExportRemote: () => void;
  onSeedDemo: (variant: 'standard' | 'diverged') => void;
  onResolve: (conflictId: string, choice: ConflictChoice) => void;
  onRetryPending: (pending: PendingMerge) => void;
  onDiscardPending: (id: string) => void;
  onDismissReport: () => void;
}

function scopeTag(conflict: MergeConflict): { text: string; intent: 'danger' | 'warning' | 'none' } {
  if (conflict.scope === 'base-diverged') return { text: '冻结基线', intent: 'danger' };
  if (conflict.scope === 'step-life') return { text: '步骤删改', intent: 'danger' };
  if (conflict.scope === 'comment') return { text: '批注', intent: 'warning' };
  if (conflict.scope === 'process-field') return { text: '流程字段', intent: 'warning' };
  return { text: '步骤字段', intent: 'warning' };
}

function MergeCenter(props: MergeCenterProps) {
  const { process } = props;
  const report = process.mergeReport;
  const derived = useMemo(() => deriveReviewState(process), [process]);
  const importInputRef = useRef<HTMLTextAreaElement>(null);

  const remoteChanges = report?.changes.filter((change) => change.side === 'remote') ?? [];
  const localChanges = report?.changes.filter((change) => change.side === 'local') ?? [];

  return (
    <main className="merge-layout">
      <section className="merge-main">
        <Card elevation={Elevation.ONE} className="merge-card">
          <div className="card-title">
            <div><span>OFFLINE BRANCHES</span><h3>其它页签草稿</h3></div>
            <Tag minimal intent={props.peers.length ? 'primary' : 'none'}>{props.peers.length} 个可合并页签</Tag>
          </div>
          <p className="muted">
            两个页签断网后各自续写，保存不再互相覆盖；重新连上后选择对端草稿做三路合并。单边改动直接接上，同一步骤或同一条批注两边都改时保留两份由你决定。
          </p>
          <div className="peer-list">
            {props.peers.map((peer) => (
              <article key={peer.branchId}>
                <div className="peer-copy">
                  <Icon icon="people" size={16} />
                  <div>
                    <strong>{peer.label}</strong>
                    <small>更新于 {new Date(peer.updatedAt).toLocaleString('zh-CN')} · {peer.process.steps.length} 个步骤 · 版本 {peer.process.version}</small>
                  </div>
                </div>
                <Button small intent="primary" icon="git-merge" text="合并此草稿" onClick={() => props.onMergePeer(peer)} />
              </article>
            ))}
            {!props.peers.length && (
              <div className="empty-diff">
                <Icon icon="offline" size={30} />
                <strong>暂未发现其它页签草稿</strong>
                <p>在浏览器再开一个本页面并编辑，或用下方演示 / 导入功能载入对端续写的草稿。</p>
              </div>
            )}
          </div>
        </Card>

        <Card elevation={Elevation.ONE} className="merge-card">
          <div className="card-title"><div><span>IMPORT / EXPORT</span><h3>草稿导入导出</h3></div></div>
          <TextArea fill rows={3} inputRef={(el: HTMLTextAreaElement | null) => { importInputRef.current = el; }} placeholder="粘贴另一台机器/另一个页签导出的草稿 JSON…" />
          <div className="merge-toolbar">
            <Button icon="import" text="导入并合并粘贴的草稿" onClick={() => props.onImportRemote(importInputRef.current?.value ?? '')} />
            <Button icon="export" text="导出本页草稿" onClick={props.onExportRemote} />
          </div>
        </Card>

        {props.pendingMerges.length > 0 && (
          <Card elevation={Elevation.ONE} className="merge-card">
            <div className="card-title">
              <div><span>RETRY QUEUE</span><h3>失败待重试</h3></div>
              <Tag intent="danger">{props.pendingMerges.length} 笔</Tag>
            </div>
            <p className="muted">上一次合并处理失败，原草稿未改动。修好问题后可直接重试。</p>
            {props.pendingMerges.map((pending) => (
              <div className="pending-row" key={pending.id}>
                <div><strong>{pending.remoteLabel}</strong><small>{pending.message}</small></div>
                <div>
                  <Button small icon="refresh" intent="primary" text="重试" onClick={() => props.onRetryPending(pending)} />
                  <Button small minimal icon="cross" text="放弃" onClick={() => props.onDiscardPending(pending.id)} />
                </div>
              </div>
            ))}
          </Card>
        )}

        {report && (
          <Card elevation={Elevation.ONE} className="merge-card report-card">
            <div className="card-title">
              <div>
                <span>MERGE REPORT</span>
                <h3>合并报告 · 与 {report.remoteLabel}</h3>
              </div>
              <div className="report-tags">
                {report.baseDiverged
                  ? <Tag intent="danger" icon="git-branch">基线分叉 · 双修订分支保留</Tag>
                  : <Tag intent="primary" icon="git-branch">共同基线 {report.baseVersionLabel}</Tag>}
                <Tag minimal>{new Date(report.at).toLocaleString('zh-CN')}</Tag>
                {report.conflicts.length === 0
                  ? <Button small minimal icon="cross" onClick={props.onDismissReport} />
                  : <Tag intent="warning">{report.conflicts.length} 条待裁决</Tag>}
              </div>
            </div>

            {report.baseDiverged && (
              <Callout intent="danger" icon="git-branch" className="merge-callout">
                <strong>一侧基于的冻结版本已被另一侧修订</strong>
                <p>没有从旧快照重写底稿：已保留两条修订分支，字段改动按共同祖先合并，方向冲突请在下方逐条确认。</p>
              </Callout>
            )}

            <div className="change-columns">
              <div>
                <h5>本页改动（{localChanges.length}）</h5>
                {localChanges.map((change, index) => (
                  <p key={`l-${index}`} className="change-line local"><Icon icon="dot" size={12} /> {change.text}</p>
                ))}
                {!localChanges.length && <p className="muted">无</p>}
              </div>
              <div>
                <h5>对端改动（{remoteChanges.length}）· 已自动接上 {report.applied} 项</h5>
                {remoteChanges.map((change, index) => (
                  <p key={`r-${index}`} className="change-line remote"><Icon icon="dot" size={12} /> {change.text}</p>
                ))}
                {!remoteChanges.length && <p className="muted">无</p>}
              </div>
            </div>

            {derived.staleConfirmedStepIds.size > 0 && (
              <Callout intent="warning" icon="updated" className="merge-callout">
                <strong>{derived.staleConfirmedStepIds.size} 个已确认步骤因步骤、依赖或危险项变化需重新确认</strong>
                <p>下游确认已立即重算，冻结检查读取同一结果：{[...derived.staleConfirmedStepIds].map((id) => process.steps.find((step) => step.id === id)?.title).filter(Boolean).join('、')}。</p>
              </Callout>
            )}

            <h5 className="conflict-heading">需要人工决定（{report.conflicts.length}）</h5>
            <div className="conflict-list">
              {report.conflicts.map((conflict) => {
                const meta = scopeTag(conflict);
                return (
                  <article key={conflict.id} className="conflict-item">
                    <header>
                      <div><Tag minimal intent={meta.intent}>{meta.text}</Tag><strong>{conflict.label}</strong></div>
                    </header>
                    <p className="conflict-detail">{conflict.detail}</p>
                    <div className="conflict-values">
                      <div className="value-card local">
                        <span>{conflict.localLabel}</span>
                        <pre>{conflict.localValue}</pre>
                      </div>
                      <Icon icon="swap-horizontal" />
                      <div className="value-card remote">
                        <span>{conflict.remoteLabel}</span>
                        <pre>{conflict.remoteValue}</pre>
                      </div>
                    </div>
                    <div className="conflict-actions">
                      <Button small icon="document-open" text={`采用${conflict.localLabel}`} onClick={() => props.onResolve(conflict.id, 'local')} />
                      <Button small icon="document-open" text={`采用${conflict.remoteLabel}`} intent="primary" onClick={() => props.onResolve(conflict.id, 'remote')} />
                      {conflict.supportsBoth && <Button small icon="duplicate" text="两份都保留" onClick={() => props.onResolve(conflict.id, 'both')} />}
                    </div>
                  </article>
                );
              })}
              {!report.conflicts.length && (
                <Callout intent="success" icon="tick-circle" className="merge-callout">
                  全部冲突已裁决，合并底稿与同步基线已更新，可以继续编辑、复核或冻结。
                </Callout>
              )}
            </div>
          </Card>
        )}
      </section>

      <aside className="merge-side">
        <Card elevation={Elevation.ONE} className="merge-card">
          <div className="card-title"><div><span>SIMULATE</span><h3>离线续写演示</h3></div></div>
          <p className="muted">直接构造一个“复核页签”断网续写后的草稿，用于演示自动合并与冲突裁决。</p>
          <Button fill icon="git-branch" text="载入标准续写场景" className="side-btn" onClick={() => props.onSeedDemo('standard')} />
          <Button fill icon="git-branch" intent="warning" text="载入旧冻结版分叉场景" className="side-btn" onClick={() => props.onSeedDemo('diverged')} />
        </Card>

        <Card elevation={Elevation.ONE} className="merge-card">
          <div className="card-title"><div><span>FAILURE & RETRY</span><h3>处理失败保护</h3></div></div>
          <label className="fail-switch">
            <input type="checkbox" checked={props.failMode} onChange={(event) => props.onToggleFailMode(event.target.checked)} />
            <span>模拟下一次合并处理失败</span>
          </label>
          <p className="muted">开启后执行合并会在写入前报错，当前草稿原样保留，失败记录进入重试队列。</p>
          {props.lastMergeError && <Callout intent="danger" icon="warning-sign" className="merge-callout">{props.lastMergeError}</Callout>}
        </Card>

        <Card elevation={Elevation.ONE} className="merge-card">
          <div className="card-title"><div><span>MERGE RULES</span><h3>合并规则</h3></div></div>
          <HTMLTable compact className="rules-table">
            <tbody>
              <tr><td><Icon icon="tick" intent="success" /></td><td>单边改动直接接上（含新增步骤、批注）</td></tr>
              <tr><td><Icon icon="warning-sign" intent="warning" /></td><td>同步骤字段 / 同批注两边都改，保留两份</td></tr>
              <tr><td><Icon icon="updated" intent="warning" /></td><td>步骤、依赖、危险项变更立即重算下游确认</td></tr>
              <tr><td><Icon icon="lock" intent="danger" /></td><td>冻结检查与确认重算读取同一结果</td></tr>
              <tr><td><Icon icon="git-branch" intent="danger" /></td><td>旧冻结版修订分叉时保留两条分支</td></tr>
              <tr><td><Icon icon="refresh" intent="primary" /></td><td>处理失败保留原草稿，可重试</td></tr>
            </tbody>
          </HTMLTable>
        </Card>
      </aside>
    </main>
  );
}

export default MergeCenter;
