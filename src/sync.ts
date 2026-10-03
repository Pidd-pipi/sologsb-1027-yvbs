import type {
  DiffItem,
  ExperimentProcess,
  MergeConflict,
  ProcessStatus,
  ProcessStep,
  ReviewComment,
  RevisionBranch,
  StoredRecord
} from './types';

export const STORAGE_KEY = 'sologsb-1027-lab-safety-v1';
export const BACKUP_KEY = `${STORAGE_KEY}-backup`;

export const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/* ------------------------------------------------------------------ */
/* 确认重算：步骤、依赖或危险项变化后，下游确认立即重算                    */
/* ------------------------------------------------------------------ */

/** 安全相关字段摘要：内容、用量、危险项、控制措施、依赖等任一变化都会改变摘要 */
export function stepDigest(step: ProcessStep): string {
  return JSON.stringify([
    step.title,
    step.purpose,
    step.materials,
    step.equipment,
    step.amount,
    step.duration,
    step.hazards,
    step.controls,
    step.dependencies,
    step.safetyNote,
    step.expectedResult
  ]);
}

/**
 * 重算全部步骤的确认状态：
 * - 已确认步骤自身内容偏离确认时摘要，或任一上游步骤未确认 → 置回待复核；
 * - 内容恢复到与确认摘要一致且上游均已确认 → 自动还原确认。
 * 冻结检查、提交门槛读取的都是这一份重算结果。
 */
export function recalculateConfirmations(steps: ProcessStep[]): { steps: ProcessStep[]; invalidated: string[] } {
  const result = steps.map((step) => ({ ...step }));
  const byId = new Map(result.map((step) => [step.id, step]));
  const contentStale = (step: ProcessStep): boolean =>
    Boolean(step.confirmedDigest) && step.confirmedDigest !== stepDigest(step);
  const depsConfirmed = (step: ProcessStep): boolean =>
    step.dependencies.every((id) => byId.get(id)?.status === 'confirmed');

  const invalidated: string[] = [];
  let touched = false;
  for (let round = 0; round <= result.length + 1; round += 1) {
    let changed = false;
    for (const step of result) {
      if (step.status === 'confirmed' && (contentStale(step) || !depsConfirmed(step))) {
        step.status = 'submitted';
        step.confirmationStale = true;
        invalidated.push(step.id);
        changed = true;
        touched = true;
      } else if (
        step.status !== 'confirmed' &&
        step.confirmationStale &&
        Boolean(step.confirmedDigest) &&
        !contentStale(step) &&
        depsConfirmed(step)
      ) {
        step.status = 'confirmed';
        step.confirmationStale = false;
        changed = true;
        touched = true;
      }
    }
    if (!changed) break;
  }
  return { steps: touched ? result : steps, invalidated: [...new Set(invalidated)] };
}

export function normalizeProcess(process: ExperimentProcess): ExperimentProcess {
  const { steps } = recalculateConfirmations(process.steps);
  return steps === process.steps ? process : { ...process, steps };
}

/* ------------------------------------------------------------------ */
/* 本地记录读写与迁移                                                    */
/* ------------------------------------------------------------------ */

export function migrateProcess(raw: unknown): ExperimentProcess | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<ExperimentProcess>;
  if (!value.id || !Array.isArray(value.steps)) return null;
  const process = value as ExperimentProcess;
  process.versions = Array.isArray(process.versions) ? process.versions : [];
  process.branches = Array.isArray(process.branches) ? process.branches : [];
  process.conflicts = Array.isArray(process.conflicts) ? process.conflicts : [];
  process.resolvedConflicts = Array.isArray(process.resolvedConflicts) ? process.resolvedConflicts : [];
  process.draftId = process.draftId || uid('draft');
  process.baseVersionId = process.baseVersionId || process.versions.at(-1)?.id || '';
  process.steps.forEach((step) => {
    step.comments = Array.isArray(step.comments) ? step.comments : [];
    step.hazards = Array.isArray(step.hazards) ? step.hazards : [];
    step.dependencies = Array.isArray(step.dependencies) ? step.dependencies : [];
    if (step.status === 'confirmed' && !step.confirmedDigest) step.confirmedDigest = stepDigest(step);
  });
  return normalizeProcess(process);
}

function parseRecord(raw: string | null): StoredRecord | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw) as unknown;
  if (parsed && typeof parsed === 'object' && 'process' in parsed && 'revision' in parsed) {
    const record = parsed as StoredRecord;
    const process = migrateProcess(record.process);
    if (!process) return null;
    record.process = process;
    return record;
  }
  const legacy = migrateProcess(parsed);
  return legacy ? { revision: '', savedAt: legacy.updatedAt ?? '', savedBy: '', tabId: '', process: legacy } : null;
}

/** 读取共享记录；数据损坏时隔离到备份键并返回 null，绝不抛异常 */
export function readStoredRecord(): StoredRecord | null {
  try {
    return parseRecord(localStorage.getItem(STORAGE_KEY));
  } catch {
    try {
      const broken = localStorage.getItem(STORAGE_KEY);
      if (broken) localStorage.setItem(BACKUP_KEY, broken);
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* 隔离失败也不阻塞 */
    }
    return null;
  }
}

/** 启动载入：主记录不可用时回退到备份记录 */
export function loadInitialRecord(): StoredRecord | null {
  const record = readStoredRecord();
  if (record) return record;
  try {
    return parseRecord(localStorage.getItem(BACKUP_KEY));
  } catch {
    return null;
  }
}

/** 写入共享记录并滚动保留上一份备份；localStorage 异常会抛给调用方走重试流程 */
export function writeStoredRecord(process: ExperimentProcess, meta: { savedBy: string; tabId: string }): StoredRecord {
  const previous = localStorage.getItem(STORAGE_KEY);
  const record: StoredRecord = {
    revision: uid('rev'),
    savedAt: new Date().toISOString(),
    savedBy: meta.savedBy,
    tabId: meta.tabId,
    process: clone(process)
  };
  const serialized = JSON.stringify(record);
  localStorage.setItem(STORAGE_KEY, serialized);
  if (previous && previous !== serialized) {
    try {
      localStorage.setItem(BACKUP_KEY, previous);
    } catch {
      /* 备份失败不影响主流程 */
    }
  }
  return record;
}

/* ------------------------------------------------------------------ */
/* 三方合并                                                             */
/* ------------------------------------------------------------------ */

export interface MergeSideLabels {
  shared: string;
  local: string;
}

export interface MergeStats {
  auto: number;
  conflicts: number;
}

const PROCESS_FIELD_LABELS: Record<string, string> = {
  title: '实验名称',
  code: '流程编号',
  objective: '实验目标',
  principal: '负责人',
  lab: '实验区域',
  status: '流程状态',
  version: '版本号',
  frozenAt: '冻结时间'
};

const STEP_FIELD_LABELS: Record<string, string> = {
  title: '步骤名称',
  purpose: '操作目的',
  materials: '材料',
  equipment: '设备',
  amount: '用量 / 参数',
  duration: '预计时间',
  hazards: '危险项',
  controls: '控制措施',
  dependencies: '依赖关系',
  safetyNote: '安全说明',
  expectedResult: '预期结果',
  status: '复核状态'
};

const SCALAR_FIELDS = ['title', 'code', 'objective', 'principal', 'lab', 'status', 'version', 'frozenAt'] as const;
const STEP_MERGE_FIELDS = [
  'title', 'purpose', 'materials', 'equipment', 'amount', 'duration',
  'hazards', 'controls', 'dependencies', 'safetyNote', 'expectedResult', 'status'
] as const;

export function conflictFingerprint(conflict: MergeConflict): string {
  const pair = [JSON.stringify(conflict.sharedValue ?? null), JSON.stringify(conflict.localValue ?? null)].sort();
  return `${conflict.id}|${JSON.stringify(conflict.baseValue ?? null)}|${pair[0]}|${pair[1]}`;
}

function mergeComments(
  baseComments: ReviewComment[],
  ourComments: ReviewComment[],
  theirComments: ReviewComment[],
  ctx: {
    stepId: string;
    stepTitle: string;
    labels: MergeSideLabels;
    conflicts: MergeConflict[];
    resolved: Set<string>;
    countAuto: () => void;
  }
): ReviewComment[] {
  const baseMap = new Map(baseComments.map((comment) => [comment.id, comment]));
  const ourMap = new Map(ourComments.map((comment) => [comment.id, comment]));
  const theirMap = new Map(theirComments.map((comment) => [comment.id, comment]));
  const ids = [...new Set([...baseMap.keys(), ...ourMap.keys(), ...theirMap.keys()])];
  const merged: ReviewComment[] = [];

  for (const id of ids) {
    const base = baseMap.get(id);
    const ours = ourMap.get(id);
    const theirs = theirMap.get(id);
    if (ours && theirs) {
      if (equal(ours, theirs) || !base) {
        merged.push(ours);
      } else if (equal(base, ours)) {
        merged.push(theirs);
        ctx.countAuto();
      } else if (equal(base, theirs)) {
        merged.push(ours);
        ctx.countAuto();
      } else {
        const conflict: MergeConflict = {
          id: `cm:${ctx.stepId}:${id}`,
          kind: 'comment',
          stepId: ctx.stepId,
          commentId: id,
          title: `步骤「${ctx.stepTitle}」· 批注（${theirs.author}）`,
          baseValue: base ?? null,
          sharedValue: theirs,
          sharedLabel: ctx.labels.shared,
          localValue: ours,
          localLabel: ctx.labels.local
        };
        if (!ctx.resolved.has(conflictFingerprint(conflict)) && !ctx.conflicts.some((item) => item.id === conflict.id)) {
          ctx.conflicts.push(conflict);
        }
        merged.push(theirs);
      }
    } else if (ours || theirs) {
      const present = (ours ?? theirs)!;
      if (!base) {
        merged.push(present); // 单边新增，直接接上
        ctx.countAuto();
      } else if (equal(base, present)) {
        ctx.countAuto(); // 另一侧删除且本侧未改 → 接受删除
      } else {
        const conflict: MergeConflict = {
          id: `cm:${ctx.stepId}:${id}`,
          kind: 'comment',
          stepId: ctx.stepId,
          commentId: id,
          title: `步骤「${ctx.stepTitle}」· 批注（${present.author}）`,
          baseValue: base,
          sharedValue: theirs ?? null,
          sharedLabel: ctx.labels.shared,
          localValue: ours ?? null,
          localLabel: ctx.labels.local
        };
        if (!ctx.resolved.has(conflictFingerprint(conflict)) && !ctx.conflicts.some((item) => item.id === conflict.id)) {
          ctx.conflicts.push(conflict);
        }
        merged.push(present); // 删除与修改冲突：先保留修改版，等待人工决定
      }
    }
  }
  return merged.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function mergeSteps(
  baseSteps: ProcessStep[],
  ourSteps: ProcessStep[],
  theirSteps: ProcessStep[],
  labels: MergeSideLabels,
  conflicts: MergeConflict[],
  resolved: Set<string>,
  countAuto: () => void
): ProcessStep[] {
  const baseMap = new Map(baseSteps.map((step) => [step.id, step]));
  const ourMap = new Map(ourSteps.map((step) => [step.id, step]));
  const theirMap = new Map(theirSteps.map((step) => [step.id, step]));
  const kept = new Map<string, ProcessStep>();

  const ids = [...new Set([...baseMap.keys(), ...ourMap.keys(), ...theirMap.keys()])];
  for (const id of ids) {
    const base = baseMap.get(id);
    const ours = ourMap.get(id);
    const theirs = theirMap.get(id);

    if (ours && theirs) {
      if (equal(ours, theirs)) {
        kept.set(id, clone(ours));
        continue;
      }
      const stepBase = base ?? ours;
      const mergedStep = clone(theirs) as ProcessStep;
      for (const field of STEP_MERGE_FIELDS) {
        const key = field as keyof ProcessStep;
        const ourValue = ours[key];
        const theirValue = theirs[key];
        const baseValue = base ? base[key] : undefined;
        if (equal(ourValue, theirValue)) {
          (mergedStep as unknown as Record<string, unknown>)[key] = clone(ourValue);
        } else if (base && equal(baseValue, ourValue)) {
          countAuto(); // 共享底稿的值已落在 mergedStep 上
        } else if (base && equal(baseValue, theirValue)) {
          (mergedStep as unknown as Record<string, unknown>)[key] = clone(ourValue);
          countAuto();
        } else {
          const conflict: MergeConflict = {
            id: `sf:${id}:${field}`,
            kind: 'step-field',
            stepId: id,
            field,
            title: `步骤「${theirs.title || ours.title}」· ${STEP_FIELD_LABELS[field] ?? field}`,
            baseValue: baseValue ?? null,
            sharedValue: theirValue ?? null,
            sharedLabel: labels.shared,
            localValue: ourValue ?? null,
            localLabel: labels.local
          };
          if (!resolved.has(conflictFingerprint(conflict)) && !conflicts.some((item) => item.id === conflict.id)) {
            conflicts.push(conflict);
          }
        }
      }
      // 确认摘要等派生字段静默三方合并，最终由确认重算统一校正
      mergedStep.confirmedDigest = pickAuto(stepBase.confirmedDigest, ours.confirmedDigest, theirs.confirmedDigest);
      mergedStep.confirmationStale = pickAuto(stepBase.confirmationStale, ours.confirmationStale, theirs.confirmationStale);
      mergedStep.comments = mergeComments(base?.comments ?? [], ours.comments, theirs.comments, {
        stepId: id,
        stepTitle: theirs.title || ours.title,
        labels,
        conflicts,
        resolved,
        countAuto
      });
      kept.set(id, mergedStep);
      continue;
    }

    if (ours || theirs) {
      const present = (ours ?? theirs)!;
      if (!base) {
        kept.set(id, clone(present)); // 单边新增步骤，直接接上
        countAuto();
        continue;
      }
      if (equal(base, present)) {
        countAuto(); // 另一侧删除且本侧未改 → 接受删除
        continue;
      }
      // 一侧删除、一侧修改：保留修改版，同时留下冲突让人决定
      const conflict: MergeConflict = {
        id: `sd:${id}`,
        kind: 'step-deletion',
        stepId: id,
        title: `步骤「${present.title}」· 删除或保留`,
        baseValue: base,
        sharedValue: theirs ? clone(theirs) : null,
        sharedLabel: labels.shared,
        localValue: ours ? clone(ours) : null,
        localLabel: labels.local
      };
      if (!resolved.has(conflictFingerprint(conflict)) && !conflicts.some((item) => item.id === conflict.id)) {
        conflicts.push(conflict);
      }
      kept.set(id, clone(present));
    }
  }

  // 顺序：以本页步骤顺序为主，另一侧新增步骤插到其最近前驱之后
  const result: ProcessStep[] = [];
  for (const step of ourSteps) {
    const merged = kept.get(step.id);
    if (merged) result.push(merged);
  }
  for (let index = 0; index < theirSteps.length; index += 1) {
    const id = theirSteps[index].id;
    if (!kept.has(id) || result.some((step) => step.id === id)) continue;
    let insertAt = -1;
    for (let back = index - 1; back >= 0; back -= 1) {
      const position = result.findIndex((step) => step.id === theirSteps[back].id);
      if (position >= 0) {
        insertAt = position + 1;
        break;
      }
    }
    if (insertAt < 0) {
      for (let forward = index + 1; forward < theirSteps.length; forward += 1) {
        const position = result.findIndex((step) => step.id === theirSteps[forward].id);
        if (position >= 0) {
          insertAt = position;
          break;
        }
      }
    }
    if (insertAt < 0) insertAt = result.length;
    result.splice(insertAt, 0, kept.get(id)!);
  }
  return result;
}

function pickAuto<T>(baseValue: T, ourValue: T, theirValue: T): T {
  if (equal(ourValue, theirValue)) return ourValue;
  if (equal(baseValue, ourValue)) return theirValue;
  return ourValue;
}

export function unionVersions(ours: ExperimentProcess['versions'], theirs: ExperimentProcess['versions']) {
  const map = new Map<string, ExperimentProcess['versions'][number]>();
  [...theirs, ...ours].forEach((version) => {
    const existing = map.get(version.id);
    if (!existing || existing.createdAt < version.createdAt) map.set(version.id, version);
  });
  return [...map.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function upsertBranch(list: RevisionBranch[], branch: RevisionBranch): RevisionBranch[] {
  const index = list.findIndex((item) => item.id === branch.id);
  if (index < 0) return [...list, branch];
  const next = [...list];
  next[index] = branch;
  return next;
}

function unionBranches(ours: RevisionBranch[], theirs: RevisionBranch[]): RevisionBranch[] {
  let result = [...theirs];
  ours.forEach((branch) => {
    const existing = result.find((item) => item.id === branch.id);
    if (!existing || existing.savedAt < branch.savedAt) result = upsertBranch(result, branch);
  });
  return result;
}

/**
 * 三方合并：单边改动直接接上；同一步骤字段或同一批注两边都改过，
 * 底稿先落共享值，两边的版本都保留在冲突记录里等待人工决定。
 */
export function mergeProcesses(
  base: ExperimentProcess,
  ours: ExperimentProcess,
  theirs: ExperimentProcess,
  labels: MergeSideLabels
): { merged: ExperimentProcess; stats: MergeStats } {
  let auto = 0;
  const countAuto = (): void => {
    auto += 1;
  };
  const resolved = new Set([...theirs.resolvedConflicts, ...ours.resolvedConflicts]);
  const conflicts: MergeConflict[] = [];
  [...theirs.conflicts, ...ours.conflicts].forEach((conflict) => {
    if (resolved.has(conflictFingerprint(conflict))) return;
    if (!conflicts.some((item) => item.id === conflict.id)) conflicts.push(conflict);
  });

  const merged: ExperimentProcess = {
    ...clone(theirs),
    branches: unionBranches(ours.branches, theirs.branches),
    versions: unionVersions(ours.versions, theirs.versions),
    resolvedConflicts: [...resolved].slice(-100),
    conflicts,
    // 取两侧较新的修改时间，保持确定性，避免仅时间戳差异引发的重复写入
    updatedAt: ours.updatedAt > theirs.updatedAt ? ours.updatedAt : theirs.updatedAt
  };

  for (const field of SCALAR_FIELDS) {
    const ourValue = ours[field];
    const theirValue = theirs[field];
    const baseValue = base[field];
    if (equal(ourValue, theirValue)) {
      (merged as unknown as Record<string, unknown>)[field] = ourValue;
    } else if (equal(baseValue, ourValue)) {
      (merged as unknown as Record<string, unknown>)[field] = theirValue;
      countAuto();
    } else if (equal(baseValue, theirValue)) {
      (merged as unknown as Record<string, unknown>)[field] = ourValue;
      countAuto();
    } else {
      const conflict: MergeConflict = {
        id: `pf:${field}`,
        kind: 'process-field',
        field,
        title: `流程信息 · ${PROCESS_FIELD_LABELS[field] ?? field}`,
        baseValue: baseValue ?? null,
        sharedValue: theirValue ?? null,
        sharedLabel: labels.shared,
        localValue: ourValue ?? null,
        localLabel: labels.local
      };
      if (!resolved.has(conflictFingerprint(conflict)) && !conflicts.some((item) => item.id === conflict.id)) {
        conflicts.push(conflict);
      }
      (merged as unknown as Record<string, unknown>)[field] = theirValue;
    }
  }

  merged.steps = mergeSteps(base.steps, ours.steps, theirs.steps, labels, conflicts, resolved, countAuto);
  return { merged: normalizeProcess(merged), stats: { auto, conflicts: conflicts.length } };
}

/* ------------------------------------------------------------------ */
/* 同步编排：保存时检测另一页签的写入，决定直接保存、三方合并或保留分支     */
/* ------------------------------------------------------------------ */

export interface SyncMeta {
  savedBy: string;
  tabId: string;
  formatTime: (iso: string) => string;
}

export interface SyncState {
  lastSeen: string | null;
  base: ExperimentProcess | null;
}

export interface SyncOutcome {
  kind: 'saved' | 'merged' | 'branched' | 'unchanged';
  state: SyncState;
  /** 合并结果与当前草稿不同，需要替换当前页签内容 */
  replace?: ExperimentProcess;
  /** 分支列表有更新，需要同步进当前草稿 */
  branches?: RevisionBranch[];
  savedAt?: string;
  mergeStats?: MergeStats;
}

export function synchronize(current: ExperimentProcess, state: SyncState, meta: SyncMeta): SyncOutcome {
  const writeMeta = { savedBy: meta.savedBy, tabId: meta.tabId };
  const stored = readStoredRecord();
  if (!stored) {
    const record = writeStoredRecord(current, writeMeta);
    return { kind: 'saved', state: { lastSeen: record.revision, base: record.process }, savedAt: record.savedAt };
  }
  const shared = stored.process;
  const sameLine = shared.draftId === current.draftId;
  const sameBase = shared.baseVersionId === current.baseVersionId;

  if (stored.revision === state.lastSeen && sameLine) {
    if (equal(shared, current)) return { kind: 'unchanged', state: { lastSeen: stored.revision, base: shared } };
    const record = writeStoredRecord(current, writeMeta);
    return { kind: 'saved', state: { lastSeen: record.revision, base: record.process }, savedAt: record.savedAt };
  }

  if (sameLine || sameBase) {
    const labels: MergeSideLabels = {
      shared: `另一页签 · ${stored.savedBy || '未知'} ${meta.formatTime(stored.savedAt)}`,
      local: `本页签 · ${meta.savedBy}`
    };
    const { merged, stats } = mergeProcesses(state.base ?? shared, current, shared, labels);
    const localChanged = !equal(merged, current);
    const sharedChanged = !equal(merged, shared);
    if (!localChanged && !sharedChanged) {
      return { kind: 'unchanged', state: { lastSeen: stored.revision, base: shared } };
    }
    let nextState: SyncState = { lastSeen: stored.revision, base: shared };
    let savedAt: string | undefined;
    if (sharedChanged) {
      const record = writeStoredRecord(merged, writeMeta);
      nextState = { lastSeen: record.revision, base: record.process };
      savedAt = record.savedAt;
    }
    return {
      kind: 'merged',
      state: nextState,
      replace: localChanged ? merged : undefined,
      savedAt,
      mergeStats: stats
    };
  }

  // 两侧基于不同的冻结版本：保留两条修订分支，不从旧快照重写底稿
  const branch = makeBranch(current, meta.savedBy);
  const existing = shared.branches.find((item) => item.id === branch.id);
  const upToDate = Boolean(existing) && equal(existing?.process, branch.process);
  const branches = upToDate ? shared.branches : upsertBranch(shared.branches, branch);
  let nextState: SyncState = { lastSeen: stored.revision, base: shared };
  let savedAt: string | undefined;
  if (!upToDate) {
    const nextShared = normalizeProcess({ ...shared, branches, updatedAt: new Date().toISOString() });
    const record = writeStoredRecord(nextShared, writeMeta);
    nextState = { lastSeen: record.revision, base: record.process };
    savedAt = record.savedAt;
  }
  return {
    kind: 'branched',
    state: nextState,
    branches: equal(current.branches, branches) ? undefined : branches,
    savedAt
  };
}

/* ------------------------------------------------------------------ */
/* 修订分支                                                             */
/* ------------------------------------------------------------------ */

export function processStatusLabel(status: ProcessStatus): string {
  return status === 'frozen' ? '已冻结' : status === 'in-review' ? '复核中' : status === 'revising' ? '修订中' : '草稿';
}

/** 把一条草稿线整体保留为修订分支（分支快照内不再嵌套分支列表） */
export function makeBranch(process: ExperimentProcess, savedBy: string): RevisionBranch {
  const snapshot = clone(process);
  snapshot.branches = [];
  return {
    id: process.draftId,
    label: `${process.version} · ${processStatusLabel(process.status)}`,
    baseVersionId: process.baseVersionId,
    version: process.version,
    savedAt: new Date().toISOString(),
    savedBy,
    process: snapshot
  };
}

/* ------------------------------------------------------------------ */
/* 冲突处理                                                             */
/* ------------------------------------------------------------------ */

export function applyConflictResolution(draft: ExperimentProcess, conflict: MergeConflict, side: 'shared' | 'local'): void {
  const value = side === 'shared' ? conflict.sharedValue : conflict.localValue;
  const copyOf = (input: unknown): unknown => (input === undefined || input === null ? input : clone(input));
  if (conflict.kind === 'process-field' && conflict.field) {
    (draft as unknown as Record<string, unknown>)[conflict.field] = copyOf(value);
  } else if (conflict.kind === 'step-field' && conflict.stepId && conflict.field) {
    const step = draft.steps.find((item) => item.id === conflict.stepId);
    if (step) (step as unknown as Record<string, unknown>)[conflict.field] = copyOf(value);
  } else if (conflict.kind === 'comment' && conflict.stepId && conflict.commentId) {
    const step = draft.steps.find((item) => item.id === conflict.stepId);
    if (step) {
      if (value === null || value === undefined) {
        step.comments = step.comments.filter((comment) => comment.id !== conflict.commentId);
      } else {
        const index = step.comments.findIndex((comment) => comment.id === conflict.commentId);
        if (index >= 0) step.comments[index] = clone(value) as ReviewComment;
        else step.comments.push(clone(value) as ReviewComment);
      }
    }
  } else if (conflict.kind === 'step-deletion' && conflict.stepId) {
    if (value === null || value === undefined) {
      draft.steps = draft.steps.filter((step) => step.id !== conflict.stepId);
      draft.steps.forEach((step) => {
        step.dependencies = step.dependencies.filter((id) => id !== conflict.stepId);
      });
    } else {
      const index = draft.steps.findIndex((step) => step.id === conflict.stepId);
      const snapshot = clone(value) as ProcessStep;
      if (index >= 0) draft.steps[index] = snapshot;
      else draft.steps.push(snapshot);
    }
  }
  draft.conflicts = draft.conflicts.filter((item) => item.id !== conflict.id);
  draft.resolvedConflicts = [...draft.resolvedConflicts, conflictFingerprint(conflict)].slice(-100);
}

export function renderConflictValue(value: unknown): string {
  if (value === null || value === undefined) return '（已删除）';
  if (Array.isArray(value)) return value.length ? value.join('、') : '（空）';
  if (typeof value === 'object') {
    const comment = value as ReviewComment;
    if ('text' in comment) return comment.text;
    return JSON.stringify(value);
  }
  const text = String(value);
  return text.trim() ? text : '（空）';
}

/* ------------------------------------------------------------------ */
/* 版本差异                                                             */
/* ------------------------------------------------------------------ */

export function diffSteps(baseSteps: ProcessStep[], targetSteps: ProcessStep[]): DiffItem[] {
  const diffs: DiffItem[] = [];
  const targetMap = new Map(targetSteps.map((step) => [step.id, step]));
  const baseMap = new Map(baseSteps.map((step) => [step.id, step]));
  baseSteps.forEach((step) => {
    if (!targetMap.has(step.id)) diffs.push({ id: step.id, title: step.title, kind: 'removed', detail: '目标版本已删除该步骤。' });
  });
  targetSteps.forEach((step) => {
    const before = baseMap.get(step.id);
    if (!before) {
      diffs.push({ id: step.id, title: step.title, kind: 'added', detail: `${step.duration} 分钟；危险项：${step.hazards.join('、') || '无'}` });
      return;
    }
    const fields: string[] = [];
    if (before.title !== step.title) fields.push('名称');
    if (before.purpose !== step.purpose) fields.push('目的');
    if (before.materials !== step.materials || before.amount !== step.amount) fields.push('材料或用量');
    if (before.equipment !== step.equipment) fields.push('设备');
    if (before.duration !== step.duration) fields.push('预计时间');
    if (JSON.stringify(before.hazards) !== JSON.stringify(step.hazards)) fields.push('危险项');
    if (before.controls !== step.controls || before.safetyNote !== step.safetyNote) fields.push('安全控制');
    if (JSON.stringify(before.dependencies) !== JSON.stringify(step.dependencies)) fields.push('依赖关系');
    if (before.expectedResult !== step.expectedResult) fields.push('预期结果');
    if (fields.length) diffs.push({ id: step.id, title: step.title, kind: 'changed', detail: `变化字段：${fields.join('、')}。` });
  });
  return diffs;
}
