import { isStepContentKey, STEP_FIELD_LABELS, PROCESS_FIELD_LABELS, uid, clone } from './derive';
import type {
  ConflictChoice,
  ExperimentProcess,
  MergeChangeEntry,
  MergeConflict,
  MergeReport,
  ProcessStep,
  ReviewComment,
  VersionSnapshot
} from './types';

const SIDE_LABEL_LOCAL = '本页草稿';
const SIDE_LABEL_REMOTE = '对端草稿';

function equalValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  return a === b;
}

function stringifyValue(value: unknown): string {
  if (Array.isArray(value)) return (value as string[]).join('、') || '（空）';
  if (value === undefined || value === null || value === '') return '（空）';
  return String(value);
}

function commentsEqual(a: ReviewComment, b: ReviewComment): boolean {
  return a.text === b.text && a.resolved === b.resolved;
}

function stepChangedFrom(base: ProcessStep, candidate: ProcessStep): boolean {
  const keys = Object.keys(base).filter((key) => isStepContentKey(key) || key === 'status') as (keyof ProcessStep)[];
  if (keys.some((key) => !equalValue(base[key], candidate[key]))) return true;
  if (base.comments.length !== candidate.comments.length) return true;
  const baseComments = new Map(base.comments.map((comment) => [comment.id, comment]));
  return candidate.comments.some((comment) => {
    const before = baseComments.get(comment.id);
    return !before || !commentsEqual(before, comment);
  });
}

/** 字符串集合三路合并（危险项、依赖）：单边增删直接采用，双方增删取并集，不产生字段冲突 */
function mergeStringSets(base: string[], local: string[], remote: string[]): { value: string[] } {
  const baseSet = new Set(base);
  const localSet = new Set(local);
  const remoteSet = new Set(remote);
  const merged = new Set<string>();
  baseSet.forEach((item) => {
    if (localSet.has(item) || remoteSet.has(item)) merged.add(item);
  });
  localSet.forEach((item) => { if (!baseSet.has(item)) merged.add(item); });
  remoteSet.forEach((item) => { if (!baseSet.has(item)) merged.add(item); });
  return { value: [...merged] };
}

interface CommonBase {
  base: ExperimentProcess | null;
  baseVersionId: string;
  baseVersionLabel: string;
  /** 两侧锚定的冻结版本不同：一侧基于已被另一侧修订的冻结版 */
  diverged: boolean;
}

function materializeSnapshot(snapshot: VersionSnapshot, template: ExperimentProcess): ExperimentProcess {
  return {
    ...clone(template),
    status: 'frozen',
    version: snapshot.version,
    frozenAt: snapshot.createdAt,
    steps: clone(snapshot.steps),
    versions: [],
    mergeReport: null,
    updatedAt: snapshot.createdAt
  };
}

/** 寻找两侧的共同祖先：同步锚点相同用锚点，否则取双方共有的最新冻结版；都没有则无法安全三路合并 */
function findCommonBase(local: ExperimentProcess, remote: ExperimentProcess): CommonBase {
  const localAnchor = local.sync;
  const remoteAnchor = remote.sync;
  if (localAnchor && remoteAnchor && localAnchor.baseVersionId === remoteAnchor.baseVersionId) {
    return {
      base: clone(localAnchor.base),
      baseVersionId: localAnchor.baseVersionId,
      baseVersionLabel: localAnchor.base.version,
      diverged: false
    };
  }
  const remoteVersionIds = new Set(remote.versions.map((version) => version.id));
  const shared = local.versions
    .filter((version) => remoteVersionIds.has(version.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (shared) {
    const diverged = Boolean(localAnchor && remoteAnchor && localAnchor.baseVersionId !== remoteAnchor.baseVersionId);
    return {
      base: materializeSnapshot(shared, local),
      baseVersionId: shared.id,
      baseVersionLabel: shared.version,
      diverged
    };
  }
  return { base: null, baseVersionId: '', baseVersionLabel: '', diverged: true };
}

function pushCommentConflict(
  result: ReviewComment[],
  conflicts: MergeConflict[],
  localComment: ReviewComment | undefined,
  remoteComment: ReviewComment | undefined,
  stepId: string,
  stepTitle: string,
  detail: string,
  localLabel: string,
  remoteLabel: string
): void {
  conflicts.push({
    id: uid('conflict'),
    scope: 'comment',
    stepId,
    stepTitle,
    commentId: localComment?.id ?? remoteComment?.id,
    label: `批注冲突 · ${stepTitle}`,
    detail,
    localValue: localComment ? `${localComment.author}：${localComment.text}${localComment.resolved ? '（已标记解决）' : ''}` : '（本页已删除该批注）',
    remoteValue: remoteComment ? `${remoteComment.author}：${remoteComment.text}${remoteComment.resolved ? '（已标记解决）' : ''}` : '（对端已删除该批注）',
    localLabel,
    remoteLabel,
    supportsBoth: Boolean(localComment && remoteComment)
  });
  // 暂存：先保留本页版本（若本页删除则暂存对端版本），裁决时按选择处理
  const provisional = localComment ? clone(localComment) : remoteComment ? clone(remoteComment) : null;
  if (provisional) result.push(provisional);
}

function mergeCommentLists(
  stepId: string,
  stepTitle: string,
  baseComments: ReviewComment[],
  localComments: ReviewComment[],
  remoteComments: ReviewComment[],
  localLabel: string,
  remoteLabel: string,
  conflicts: MergeConflict[],
  changes: MergeChangeEntry[]
): ReviewComment[] {
  const baseMap = new Map(baseComments.map((comment) => [comment.id, comment]));
  const localMap = new Map(localComments.map((comment) => [comment.id, comment]));
  const remoteMap = new Map(remoteComments.map((comment) => [comment.id, comment]));
  const result: ReviewComment[] = [];
  const handled = new Set<string>();

  baseComments.forEach((baseComment) => {
    const localComment = localMap.get(baseComment.id);
    const remoteComment = remoteMap.get(baseComment.id);
    handled.add(baseComment.id);
    if (localComment && remoteComment) {
      if (commentsEqual(baseComment, localComment) && commentsEqual(baseComment, remoteComment)) {
        result.push(clone(baseComment));
      } else if (commentsEqual(baseComment, remoteComment)) {
        result.push(clone(localComment));
        if (!commentsEqual(baseComment, localComment)) {
          changes.push({ kind: 'comment-edited', stepTitle, text: '本页修改了一条批注', side: 'local' });
        }
      } else if (commentsEqual(baseComment, localComment)) {
        result.push(clone(remoteComment));
        changes.push({ kind: 'comment-edited', stepTitle, text: '对端修改了一条批注', side: 'remote' });
      } else if (commentsEqual(localComment, remoteComment)) {
        result.push(clone(localComment));
      } else {
        pushCommentConflict(result, conflicts, localComment, remoteComment, stepId, stepTitle, '同一条批注两边都做了不同修改，两份内容均已保留待裁决。', localLabel, remoteLabel);
      }
    } else if (localComment && !remoteComment) {
      if (commentsEqual(baseComment, localComment)) {
        changes.push({ kind: 'comment-edited', stepTitle, text: '对端删除了一条批注', side: 'remote' });
      } else {
        pushCommentConflict(result, conflicts, localComment, undefined, stepId, stepTitle, '本页修改了批注，而对端删除了该批注。', localLabel, remoteLabel);
      }
    } else if (!localComment && remoteComment) {
      if (commentsEqual(baseComment, remoteComment)) {
        changes.push({ kind: 'comment-edited', stepTitle, text: '本页删除了一条批注', side: 'local' });
      } else {
        pushCommentConflict(result, conflicts, undefined, remoteComment, stepId, stepTitle, '对端修改了批注，而本页删除了该批注。', localLabel, remoteLabel);
      }
    }
  });

  // 单边新增的批注直接接上
  localComments.forEach((comment) => {
    if (handled.has(comment.id) || baseMap.has(comment.id)) return;
    handled.add(comment.id);
    if (remoteMap.has(comment.id)) {
      const remoteComment = remoteMap.get(comment.id)!;
      if (commentsEqual(comment, remoteComment)) {
        result.push(clone(comment));
      } else {
        pushCommentConflict(result, conflicts, comment, remoteComment, stepId, stepTitle, '同一条新批注两边内容不同。', localLabel, remoteLabel);
      }
      return;
    }
    result.push(clone(comment));
    changes.push({ kind: 'comment-added', stepTitle, text: `本页新增批注：${comment.text.slice(0, 30)}`, side: 'local' });
  });
  remoteComments.forEach((comment) => {
    if (handled.has(comment.id) || baseMap.has(comment.id)) return;
    handled.add(comment.id);
    result.push(clone(comment));
    changes.push({ kind: 'comment-added', stepTitle, text: `对端新增批注：${comment.text.slice(0, 30)}`, side: 'remote' });
  });

  return result;
}

const SCALAR_MERGE_KEYS = [
  'title', 'purpose', 'materials', 'equipment', 'amount', 'duration',
  'hazards', 'controls', 'dependencies', 'safetyNote', 'expectedResult', 'status'
] as const;

const BOTH_CAPABLE_KEYS = new Set(['title', 'purpose', 'materials', 'equipment', 'amount', 'controls', 'safetyNote', 'expectedResult']);

function mergeStep(
  base: ProcessStep,
  local: ProcessStep,
  remote: ProcessStep,
  localLabel: string,
  remoteLabel: string,
  conflicts: MergeConflict[],
  changes: MergeChangeEntry[]
): { step: ProcessStep; incomingContentChanged: boolean } {
  const merged: ProcessStep = clone(local);
  let incomingContentChanged = false;

  SCALAR_MERGE_KEYS.forEach((key) => {
    const baseValue = base[key];
    const localValue = local[key];
    const remoteValue = remote[key];
    const fieldLabel = STEP_FIELD_LABELS[key] ?? key;

    if (key === 'hazards' || key === 'dependencies') {
      const setResult = mergeStringSets(baseValue as string[], localValue as string[], remoteValue as string[]);
      if (!equalValue(setResult.value, localValue) && !equalValue(localValue, baseValue)) {
        // 双方都改且合并结果不同于本页：危险项/依赖按并集自动接上
      }
      if (!equalValue(setResult.value, localValue)) {
        incomingContentChanged = true;
        if (equalValue(localValue, baseValue)) {
          changes.push({ kind: 'step-field', stepTitle: merged.title, fieldLabel, text: `对端调整了${fieldLabel}`, side: 'remote' });
        }
      }
      (merged[key] as unknown) = setResult.value;
      return;
    }

    const localChanged = !equalValue(baseValue, localValue);
    const remoteChanged = !equalValue(baseValue, remoteValue);

    if (!localChanged && !remoteChanged) return;
    if (!localChanged) {
      (merged[key] as unknown) = clone(remoteValue);
      changes.push({ kind: 'step-field', stepTitle: merged.title, fieldLabel, text: `对端修改了${fieldLabel}`, side: 'remote' });
      if (isStepContentKey(key)) incomingContentChanged = true;
      return;
    }
    if (!remoteChanged) {
      changes.push({ kind: 'step-field', stepTitle: merged.title, fieldLabel, text: `本页修改了${fieldLabel}`, side: 'local' });
      return;
    }
    if (equalValue(localValue, remoteValue)) return;

    // 两边都改且不同：暂存本页值，保留两份待人工裁决
    conflicts.push({
      id: uid('conflict'),
      scope: 'step-field',
      stepId: merged.id,
      stepTitle: merged.title,
      field: key,
      fieldLabel,
      label: `${fieldLabel}冲突 · ${merged.title}`,
      detail: `同一步骤的「${fieldLabel}」两边都做了不同修改，当前先保留本页内容，请人工裁决。`,
      localValue: stringifyValue(localValue),
      remoteValue: stringifyValue(remoteValue),
      localLabel,
      remoteLabel,
      supportsBoth: BOTH_CAPABLE_KEYS.has(key)
    });
    changes.push({ kind: 'step-field', stepTitle: merged.title, fieldLabel, text: `「${fieldLabel}」两边修改不同，待人工裁决`, side: 'remote' });
  });

  merged.comments = mergeCommentLists(merged.id, merged.title, base.comments, local.comments, remote.comments, localLabel, remoteLabel, conflicts, changes);
  return { step: merged, incomingContentChanged };
}

export interface MergeOptions {
  localLabel?: string;
  remoteLabel?: string;
  /** 演示/测试用：合并处理在写入前失败，原草稿必须保留 */
  simulateFailure?: boolean;
}

/**
 * 离线三路合并：
 * - 单边改动直接接上；同一步骤字段/同一条批注两边都改 → 保留两份待裁决；
 * - 锚定冻结版已被另一侧修订时，基于共同祖先合并，不用旧快照重写当前底稿，两条修订分支都保留；
 * - 纯函数，不写存储；任何异常由调用方保留原草稿并支持重试。
 */
export function mergeProcesses(
  local: ExperimentProcess,
  remote: ExperimentProcess,
  options: MergeOptions = {}
): { process: ExperimentProcess; report: MergeReport } {
  if (options.simulateFailure) {
    throw new Error('合并处理失败（模拟）：草稿未改动，可修复后重试。');
  }
  const localLabel = options.localLabel ?? local.sync?.branchLabel ?? SIDE_LABEL_LOCAL;
  const remoteLabel = options.remoteLabel ?? remote.sync?.branchLabel ?? SIDE_LABEL_REMOTE;

  const common = findCommonBase(local, remote);
  const conflicts: MergeConflict[] = [];
  const changes: MergeChangeEntry[] = [];

  if (!common.base) {
    // 找不到共同祖先：不从任何快照重写底稿，整条对端修订分支保留待人工决定
    const merged = clone(local);
    const remoteVersions = remote.versions.filter((version) => !local.versions.some((item) => item.id === version.id));
    merged.versions = [...merged.versions, ...remoteVersions.map((version) => clone(version))]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    conflicts.push({
      id: uid('conflict'),
      scope: 'base-diverged',
      label: '冻结基线分叉',
      detail: '两侧草稿没有共同的冻结版本，无法识别共同祖先。当前底稿保持原样，对端修订分支已整体保留，请人工决定采用方向。',
      localValue: `${localLabel} · ${local.version}（${local.updatedAt}）`,
      remoteValue: `${remoteLabel} · ${remote.version}（${remote.updatedAt}）`,
      localLabel,
      remoteLabel,
      supportsBoth: false
    });
    return finishMerge(merged, local, remote, remoteLabel, common, conflicts, changes);
  }

  const base = common.base;
  const merged = clone(local);
  const baseSteps = new Map(base.steps.map((step) => [step.id, step]));
  const localSteps = new Map(local.steps.map((step) => [step.id, step]));
  const remoteSteps = new Map(remote.steps.map((step) => [step.id, step]));

  const resultSteps: ProcessStep[] = [];
  const now = new Date().toISOString();

  // 以本页顺序为主线，保证不从旧快照重写底稿
  local.steps.forEach((localStep) => {
    const baseStep = baseSteps.get(localStep.id);
    const remoteStep = remoteSteps.get(localStep.id);
    if (!baseStep) {
      // 本页新增步骤：对端若也改了同 id 才冲突，否则直接保留
      if (remoteStep) {
        const { step, incomingContentChanged } = mergeStep(clone(localStep), localStep, remoteStep, localLabel, remoteLabel, conflicts, changes);
        if (incomingContentChanged) step.contentUpdatedAt = now;
        resultSteps.push(step);
      } else {
        resultSteps.push(clone(localStep));
        changes.push({ kind: 'step-added', stepTitle: localStep.title, text: `本页新增步骤：${localStep.title}`, side: 'local' });
      }
      return;
    }
    if (!remoteStep) {
      if (stepChangedFrom(baseStep, localStep)) {
        // 本页改、对端删：保留两份意见
        conflicts.push({
          id: uid('conflict'),
          scope: 'step-life',
          stepId: localStep.id,
          stepTitle: localStep.title,
          localStep: clone(localStep),
          label: `步骤删改冲突 · ${localStep.title}`,
          detail: '本页继续修改了该步骤，而对端已将其删除，两条处理意见均已保留。',
          localValue: `保留并修改：${stringifyValue(localStep.title)}`,
          remoteValue: '（对端已删除该步骤）',
          localLabel,
          remoteLabel,
          supportsBoth: false
        });
        resultSteps.push(clone(localStep));
      } else {
        changes.push({ kind: 'step-removed', stepTitle: baseStep.title, text: `对端删除步骤：${baseStep.title}`, side: 'remote' });
      }
      return;
    }
    const { step, incomingContentChanged } = mergeStep(baseStep, localStep, remoteStep, localLabel, remoteLabel, conflicts, changes);
    if (incomingContentChanged) step.contentUpdatedAt = now;
    resultSteps.push(step);
  });

  // 对端单边新增的步骤直接接上
  remote.steps.forEach((remoteStep) => {
    if (localSteps.has(remoteStep.id)) return;
    const baseStep = baseSteps.get(remoteStep.id);
    if (baseStep) {
      if (stepChangedFrom(baseStep, remoteStep)) {
        conflicts.push({
          id: uid('conflict'),
          scope: 'step-life',
          stepId: remoteStep.id,
          stepTitle: remoteStep.title,
          remoteStep: clone(remoteStep),
          label: `步骤删改冲突 · ${remoteStep.title}`,
          detail: '对端继续修改了该步骤，而本页已将其删除，两条处理意见均已保留。',
          localValue: '（本页已删除该步骤）',
          remoteValue: `保留并修改：${stringifyValue(remoteStep.title)}`,
          localLabel,
          remoteLabel,
          supportsBoth: false
        });
        resultSteps.push(clone(remoteStep));
        changes.push({ kind: 'step-field', stepTitle: remoteStep.title, text: '步骤删除与修改冲突，待人工裁决', side: 'remote' });
      } else {
        changes.push({ kind: 'step-removed', stepTitle: baseStep.title, text: `本页删除步骤：${baseStep.title}`, side: 'local' });
      }
      return;
    }
    const added = clone(remoteStep);
    added.contentUpdatedAt = now;
    resultSteps.push(added);
    changes.push({ kind: 'step-added', stepTitle: remoteStep.title, text: `对端新增步骤：${remoteStep.title}`, side: 'remote' });
  });

  // 清理悬空依赖（指向被删步骤）
  const resultIds = new Set(resultSteps.map((step) => step.id));
  resultSteps.forEach((step) => {
    const filtered = step.dependencies.filter((id) => resultIds.has(id));
    if (filtered.length !== step.dependencies.length) step.dependencies = filtered;
  });

  merged.steps = resultSteps;

  // 流程级字段三路合并
  (['title', 'code', 'objective', 'principal', 'lab'] as const).forEach((key) => {
    const baseValue = base[key];
    const localValue = local[key];
    const remoteValue = remote[key];
    const localChanged = baseValue !== localValue;
    const remoteChanged = baseValue !== remoteValue;
    if (!localChanged && remoteChanged) {
      merged[key] = remoteValue;
      changes.push({ kind: 'step-field', fieldLabel: PROCESS_FIELD_LABELS[key], text: `对端修改了${PROCESS_FIELD_LABELS[key]}`, side: 'remote' });
    } else if (localChanged && !remoteChanged) {
      changes.push({ kind: 'step-field', fieldLabel: PROCESS_FIELD_LABELS[key], text: `本页修改了${PROCESS_FIELD_LABELS[key]}`, side: 'local' });
    } else if (localChanged && remoteChanged && localValue !== remoteValue) {
      conflicts.push({
        id: uid('conflict'),
        scope: 'process-field',
        field: key,
        fieldLabel: PROCESS_FIELD_LABELS[key],
        label: `${PROCESS_FIELD_LABELS[key]}冲突`,
        detail: `流程「${PROCESS_FIELD_LABELS[key]}」两边修改不同，当前先保留本页内容。`,
        localValue: stringifyValue(localValue),
        remoteValue: stringifyValue(remoteValue),
        localLabel,
        remoteLabel,
        supportsBoth: true
      });
    }
  });

  // 冻结版本取并集（只追加，不用旧快照覆盖）
  const remoteVersions = remote.versions.filter((version) => !local.versions.some((item) => item.id === version.id));
  remoteVersions.forEach((version) => {
    changes.push({ kind: 'version-added', text: `对端带来冻结版本 ${version.version}`, side: 'remote' });
  });
  merged.versions = [...merged.versions, ...remoteVersions.map((version) => clone(version))]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  if (common.diverged) {
    conflicts.push({
      id: uid('conflict'),
      scope: 'base-diverged',
      label: '冻结基线已分叉',
      detail: `对端草稿基于冻结版本 ${remote.sync?.base.version ?? '未知版本'} 续写，而该基线在本页已被修订。已按双方共同祖先 ${common.baseVersionLabel} 合并字段改动，两条修订分支均保留，未从旧快照重写底稿，请确认合并方向。`,
      localValue: `${localLabel} 基线：${local.sync?.base.version ?? common.baseVersionLabel}`,
      remoteValue: `${remoteLabel} 基线：${remote.sync?.base.version ?? '未知'}`,
      localLabel,
      remoteLabel,
      supportsBoth: false
    });
  }

  return finishMerge(merged, local, remote, remoteLabel, common, conflicts, changes);
}

function finishMerge(
  merged: ExperimentProcess,
  local: ExperimentProcess,
  remote: ExperimentProcess,
  remoteLabel: string,
  common: CommonBase,
  conflicts: MergeConflict[],
  changes: MergeChangeEntry[]
): { process: ExperimentProcess; report: MergeReport } {
  const now = new Date().toISOString();
  merged.updatedAt = now;
  merged.status = local.status;
  merged.version = local.version;
  merged.frozenAt = local.frozenAt;

  const report: MergeReport = {
    id: uid('merge'),
    at: now,
    remoteLabel,
    baseVersionId: common.baseVersionId,
    baseVersionLabel: common.baseVersionLabel || '无共同祖先',
    baseDiverged: common.diverged || !common.base,
    changes,
    conflicts,
    applied: changes.length,
    remote: clone(remote)
  };
  merged.mergeReport = report;

  merged.sync = {
    branchId: local.sync?.branchId ?? uid('branch'),
    branchLabel: local.sync?.branchLabel ?? SIDE_LABEL_LOCAL,
    baseVersionId: common.baseVersionId || local.sync?.baseVersionId || '',
    baseAt: now,
    base: stripSyncMeta(merged),
    mergedFrom: [...new Set([...(local.sync?.mergedFrom ?? []), remote.sync?.branchId ?? 'remote'].filter(Boolean))]
  };

  return { process: merged, report };
}

function joinBothValues(field: string | undefined, localValue: string, remoteValue: string): string {
  const longText = new Set(['objective', 'purpose', 'controls', 'safetyNote', 'expectedResult', 'materials', 'equipment']);
  return longText.has(field ?? '')
    ? `【本页修订】\n${localValue}\n【对端修订】\n${remoteValue}`
    : `${localValue} ／ ${remoteValue}`;
}

/** 生成干净的同步基线：不含合并报告，也不再嵌套 sync.base，防止存储无限膨胀 */
function stripSyncMeta(process: ExperimentProcess): ExperimentProcess {
  const anchor = clone(process);
  anchor.mergeReport = null;
  if (anchor.sync) {
    anchor.sync.base = clone({ ...anchor, sync: undefined } as ExperimentProcess);
  }
  return anchor;
}

function parseScalar(value: string, field?: string): unknown {
  if (value === '（空）') return field === 'hazards' || field === 'dependencies' ? [] : '';
  if (field === 'duration') return Number(value);
  if (field === 'hazards' || field === 'dependencies') return value.split('、').map((item) => item.trim()).filter(Boolean);
  return value;
}

/** 人工裁决一条冲突，返回新的流程对象；出错时抛异常（调用方保留原草稿，可重试） */
export function resolveConflict(process: ExperimentProcess, conflictId: string, choice: ConflictChoice): ExperimentProcess {
  const report = process.mergeReport;
  if (!report) throw new Error('没有待处理的合并冲突。');
  const conflict = report.conflicts.find((item) => item.id === conflictId);
  if (!conflict) throw new Error('该冲突已被裁决或不存在。');
  const remote = report.remote;
  if (!remote) throw new Error('对端分支数据缺失，无法裁决。');

  const next = clone(process);
  const nextReport = next.mergeReport!;
  const target = nextReport.conflicts.find((item) => item.id === conflictId)!;
  const now = new Date().toISOString();

  const dropConflict = () => {
    target.resolved = choice;
    nextReport.conflicts = nextReport.conflicts.filter((item) => item.id !== conflictId);
    next.updatedAt = now;
  };

  if (target.scope === 'base-diverged') {
    if (choice === 'remote') {
      // 人工决定整体采用对端修订分支：仍保留双方冻结版本并以本页分支身份继续
      const adopted = clone(remote);
      adopted.versions = [...adopted.versions, ...next.versions]
        .filter((version, index, array) => array.findIndex((item) => item.id === version.id) === index)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      adopted.sync = {
        branchId: next.sync?.branchId ?? uid('branch'),
        branchLabel: next.sync?.branchLabel ?? SIDE_LABEL_LOCAL,
        baseVersionId: nextReport.baseVersionId,
        baseAt: now,
        base: stripSyncMeta(adopted),
        mergedFrom: next.sync?.mergedFrom ?? []
      };
      adopted.mergeReport = { ...nextReport, conflicts: nextReport.conflicts.filter((item) => item.id !== conflictId) };
      if (!adopted.mergeReport.conflicts.length) adopted.mergeReport = null;
      return adopted;
    }
    dropConflict();
    return next;
  }

  if (target.scope === 'step-life') {
    const stepId = target.stepId!;
    const index = next.steps.findIndex((step) => step.id === stepId);
    const chosenStep = choice === 'remote' ? target.remoteStep : target.localStep;
    if (chosenStep) {
      const restored = clone(chosenStep);
      restored.contentUpdatedAt = now;
      if (index >= 0) next.steps[index] = restored;
      else next.steps.push(restored);
    } else {
      // 所选一侧的意见是删除
      next.steps = next.steps.filter((step) => step.id !== stepId);
      next.steps.forEach((step) => {
        step.dependencies = step.dependencies.filter((id) => id !== stepId);
      });
    }
    dropConflict();
    return next;
  }

  if (target.scope === 'comment') {
    const targetStep = next.steps.find((item) => item.id === target.stepId);
    if (!targetStep) throw new Error('冲突对应的步骤已不存在。');
    const remoteStep = remote.steps.find((item) => item.id === target.stepId);
    const remoteComment = remoteStep?.comments.find((comment) => comment.id === target.commentId);
    const localComment = targetStep.comments.find((comment) => comment.id === target.commentId);
    const baseExisted = Boolean(localComment);

    if (choice === 'local') {
      // 本页删除而对端修改时：若本页没有该批注，保持删除
      if (!localComment && remoteComment) {
        targetStep.comments = targetStep.comments.filter((comment) => comment.id !== remoteComment.id);
      }
    } else if (choice === 'remote') {
      if (!remoteComment) {
        targetStep.comments = targetStep.comments.filter((comment) => comment.id !== target.commentId);
      } else {
        const incoming = clone(remoteComment);
        const idx = targetStep.comments.findIndex((comment) => comment.id === remoteComment.id);
        if (idx >= 0) targetStep.comments[idx] = incoming;
        else targetStep.comments.push(incoming);
      }
    } else if (baseExisted && remoteComment && localComment) {
      const fork = clone(remoteComment);
      fork.id = `${remoteComment.id}-fork-${uid('c').slice(-5)}`;
      fork.text = `【对端】${fork.text}`;
      targetStep.comments.push(fork);
    }
    targetStep.contentUpdatedAt = now;
    dropConflict();
    return next;
  }

  // step-field / process-field
  const field = target.field;
  if (!field) throw new Error('冲突字段缺失，无法裁决。');
  const localRaw = target.scope === 'process-field'
    ? (process as unknown as Record<string, unknown>)[field]
    : (process.steps.find((item) => item.id === target.stepId) as unknown as Record<string, unknown> | undefined)?.[field];
  const remoteRaw = target.scope === 'process-field'
    ? (remote as unknown as Record<string, unknown>)[field]
    : (remote.steps.find((item) => item.id === target.stepId) as unknown as Record<string, unknown> | undefined)?.[field]
      ?? parseScalar(target.remoteValue, field);

  let applied: unknown;
  if (choice === 'local') applied = clone(localRaw);
  else if (choice === 'remote') applied = clone(remoteRaw);
  else applied = joinBothValues(field, String(localRaw ?? ''), String(remoteRaw ?? ''));

  if (target.scope === 'process-field') {
    (next as unknown as Record<string, unknown>)[field] = applied;
  } else {
    const step = next.steps.find((item) => item.id === target.stepId);
    if (!step) throw new Error('冲突对应的步骤已不存在。');
    (step as unknown as Record<string, unknown>)[field] = applied;
    step.contentUpdatedAt = now;
  }
  dropConflict();
  return next;
}

/** 裁决完成后清空已无冲突的合并报告，并刷新同步基线为合并结果 */
export function clearReportIfResolved(process: ExperimentProcess): ExperimentProcess {
  if (!process.mergeReport || process.mergeReport.conflicts.length > 0) return process;
  const next = clone(process);
  next.mergeReport = null;
  if (next.sync) {
    next.sync.baseAt = new Date().toISOString();
    next.sync.base = stripSyncMeta(next);
  }
  return next;
}
