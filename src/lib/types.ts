export type StepStatus = 'draft' | 'submitted' | 'confirmed' | 'returned';
export type ProcessStatus = 'draft' | 'in-review' | 'frozen' | 'revising';
export type ViewId = 'editor' | 'review' | 'compare' | 'merge';

export interface ReviewComment {
  id: string;
  author: string;
  role: string;
  text: string;
  createdAt: string;
  resolved: boolean;
}

export interface ProcessStep {
  id: string;
  title: string;
  purpose: string;
  materials: string;
  equipment: string;
  amount: string;
  duration: number;
  hazards: string[];
  controls: string;
  dependencies: string[];
  safetyNote: string;
  expectedResult: string;
  status: StepStatus;
  comments: ReviewComment[];
  /** 步骤内容（步骤/依赖/危险项等）最后一次修改时间，用于判定已确认内容是否过期 */
  contentUpdatedAt?: string;
  /** 最近一次人工确认的时刻；为空且状态为已确认时按旧数据兼容处理 */
  confirmedAt?: string;
}

export interface VersionSnapshot {
  id: string;
  label: string;
  version: string;
  createdAt: string;
  note: string;
  author: string;
  steps: ProcessStep[];
}

/** 离线同步锚点：base 是与对端共同的最近快照，branchId 标识当前页签分支 */
export interface SyncInfo {
  branchId: string;
  branchLabel: string;
  baseVersionId: string;
  baseAt: string;
  base: ExperimentProcess;
  mergedFrom: string[];
}

export interface BranchRecord {
  branchId: string;
  label: string;
  updatedAt: string;
  absorbedBy?: string;
  absorbedLabel?: string;
}

export type ConflictScope = 'step-field' | 'comment' | 'step-life' | 'process-field' | 'base-diverged';
export type ConflictChoice = 'local' | 'remote' | 'both';

export interface MergeConflict {
  id: string;
  scope: ConflictScope;
  stepId?: string;
  stepTitle?: string;
  commentId?: string;
  field?: keyof ProcessStep | 'title' | 'code' | 'objective' | 'principal' | 'lab';
  fieldLabel?: string;
  label: string;
  detail: string;
  localValue: string;
  remoteValue: string;
  localLabel: string;
  remoteLabel: string;
  supportsBoth: boolean;
  resolved?: ConflictChoice;
  /** 步骤被删与改冲突时，暂存两侧步骤快照 */
  localStep?: ProcessStep;
  remoteStep?: ProcessStep;
}

export interface MergeChangeEntry {
  kind: 'step-added' | 'step-removed' | 'step-field' | 'comment-added' | 'comment-edited' | 'comment-resolved' | 'version-added';
  stepTitle?: string;
  fieldLabel?: string;
  text: string;
  side: 'local' | 'remote';
}

export interface MergeReport {
  id: string;
  at: string;
  remoteLabel: string;
  baseVersionId: string;
  baseVersionLabel: string;
  baseDiverged: boolean;
  changes: MergeChangeEntry[];
  conflicts: MergeConflict[];
  applied: number;
  /** 对端完整草稿，裁决字段/批注冲突时取回对端原值；整体采用分支时作为底稿 */
  remote?: ExperimentProcess;
}

export interface ExperimentProcess {
  id: string;
  title: string;
  code: string;
  objective: string;
  principal: string;
  lab: string;
  status: ProcessStatus;
  version: string;
  steps: ProcessStep[];
  versions: VersionSnapshot[];
  frozenAt?: string;
  updatedAt: string;
  sync?: SyncInfo;
  /** 最近一次合并报告（含未解决冲突），冲突全部裁决后清空 */
  mergeReport?: MergeReport | null;
}

export interface HistoryState {
  past: ExperimentProcess[];
  present: ExperimentProcess;
  future: ExperimentProcess[];
}

export interface DiffItem {
  id: string;
  title: string;
  kind: 'added' | 'removed' | 'changed';
  detail: string;
}

/** 步骤、依赖或危险项变更后统一重算的复核/冻结结果，所有冻结入口读取同一份 */
export interface DerivedReviewState {
  missingSafetySteps: ProcessStep[];
  staleConfirmedStepIds: Set<string>;
  dependencyValid: boolean;
  dependencyIssueCount: number;
  conflictCount: number;
  confirmedCount: number;
  effectiveConfirmedCount: number;
  pendingReviewCount: number;
  reviewProgress: number;
  canFreeze: boolean;
  freezeChecks: { label: string; detail: string; passed: boolean }[];
}

export interface PeerDraft {
  branchId: string;
  label: string;
  updatedAt: string;
  process: ExperimentProcess;
}

export interface PendingMerge {
  id: string;
  at: string;
  remoteLabel: string;
  remote: ExperimentProcess;
  failMode: boolean;
  message: string;
}
