export type StepStatus = 'draft' | 'submitted' | 'confirmed' | 'returned';
export type ProcessStatus = 'draft' | 'in-review' | 'frozen' | 'revising';

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
  /** 确认时安全相关字段的摘要，内容变化后用于重算确认 */
  confirmedDigest?: string;
  /** 确认因上游或自身变更被重算置回，内容恢复后可自动还原 */
  confirmationStale?: boolean;
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

/** 基于不同冻结版本的修订分支，整体保留一份流程草稿 */
export interface RevisionBranch {
  id: string;
  label: string;
  baseVersionId: string;
  version: string;
  savedAt: string;
  savedBy: string;
  process: ExperimentProcess;
}

/** 离线合并冲突：同一处被两个页签分别修改，两份都保留等待人工决定 */
export interface MergeConflict {
  id: string;
  kind: 'process-field' | 'step-field' | 'comment' | 'step-deletion';
  stepId?: string;
  commentId?: string;
  field?: string;
  title: string;
  baseValue?: unknown;
  sharedValue: unknown;
  sharedLabel: string;
  localValue: unknown;
  localLabel: string;
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
  /** 当前草稿线的标识，开始修订时重新生成 */
  draftId: string;
  /** 当前草稿所基于的冻结版本快照 id */
  baseVersionId: string;
  branches: RevisionBranch[];
  conflicts: MergeConflict[];
  /** 已处理冲突的指纹，避免另一页签把旧冲突重新合并回来 */
  resolvedConflicts: string[];
}

export interface StoredRecord {
  revision: string;
  savedAt: string;
  savedBy: string;
  tabId: string;
  process: ExperimentProcess;
}

export interface DiffItem {
  id: string;
  title: string;
  kind: 'added' | 'removed' | 'changed';
  detail: string;
}
