import type { DerivedReviewState, ExperimentProcess, ProcessStep } from './types';

export const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** 参与“危险项 / 安全条件”判定的步骤内容字段 */
const SAFETY_CONTENT_KEYS = ['hazards', 'controls', 'safetyNote'] as const;
/** 步骤本身的内容字段（不含 status/comments，改动这些需要重算下游确认） */
const STEP_CONTENT_KEYS = [
  'title', 'purpose', 'materials', 'equipment', 'amount', 'duration',
  'hazards', 'controls', 'dependencies', 'safetyNote', 'expectedResult'
] as const;

export function hasMissingSafety(step: ProcessStep): boolean {
  return step.hazards.length > 0 && (!step.controls.trim() || !step.safetyNote.trim());
}

export function isSafetyContentKey(key: string): boolean {
  return (SAFETY_CONTENT_KEYS as readonly string[]).includes(key);
}

export function isStepContentKey(key: string): boolean {
  return (STEP_CONTENT_KEYS as readonly string[]).includes(key);
}

export const STEP_FIELD_LABELS: Record<string, string> = {
  title: '步骤名称',
  purpose: '操作目的',
  materials: '材料',
  equipment: '设备',
  amount: '用量/参数',
  duration: '预计时间',
  hazards: '危险项',
  controls: '控制措施',
  dependencies: '依赖关系',
  safetyNote: '安全说明',
  expectedResult: '预期结果',
  status: '复核状态'
};

export const PROCESS_FIELD_LABELS: Record<string, string> = {
  title: '实验名称',
  code: '流程编号',
  objective: '实验目标',
  principal: '负责人',
  lab: '实验区域'
};

/** 沿依赖边收集 sourceId 的全部下游步骤 */
export function collectDownstream(steps: ProcessStep[], sourceId: string | null): string[] {
  if (!sourceId) return [];
  const result = new Set<string>();
  const visit = (id: string) => {
    steps.filter((step) => step.dependencies.includes(id)).forEach((step) => {
      if (result.has(step.id)) return;
      result.add(step.id);
      visit(step.id);
    });
  };
  visit(sourceId);
  return [...result];
}

/** 收集直接依赖（用于展示“因为哪些上游变更而过期”） */
export function collectUpstream(steps: ProcessStep[], targetId: string): string[] {
  const target = steps.find((step) => step.id === targetId);
  if (!target) return [];
  return target.dependencies.filter((id) => steps.some((step) => step.id === id));
}

/**
 * 统一复核/冻结派生结果：
 * 已确认步骤的任一上游（含其自身之外的传递依赖）在其确认之后改过步骤、依赖或危险项，
 * 即判定为过期确认，需要重新确认；冻结检查读取同一结果。
 */
export function deriveReviewState(process: ExperimentProcess): DerivedReviewState {
  const steps = process.steps;
  const missingSafetySteps = steps.filter(hasMissingSafety);

  const byId = new Map(steps.map((step) => [step.id, step]));
  const staleConfirmedStepIds = new Set<string>();

  // 每个被确认步骤独立做一次传递依赖扫描；确认时刻之后任一上游的内容变更都使其过期
  const upstreamHasNewerChange = (startId: string, confirmedAt: string): boolean => {
    const seen = new Set<string>([startId]);
    const stack = [...(byId.get(startId)?.dependencies ?? [])];
    while (stack.length) {
      const depId = stack.pop()!;
      if (seen.has(depId)) continue;
      seen.add(depId);
      const dep = byId.get(depId);
      if (!dep) continue;
      if (dep.contentUpdatedAt !== undefined && dep.contentUpdatedAt > confirmedAt) return true;
      stack.push(...dep.dependencies);
    }
    return false;
  };

  steps.forEach((step) => {
    if (step.status !== 'confirmed') return;
    // 兼容旧数据：没有显式确认时刻时，以内容时间作为确认时刻
    const confirmedAt = step.confirmedAt ?? step.contentUpdatedAt ?? '';
    if (confirmedAt && upstreamHasNewerChange(step.id, confirmedAt)) {
      staleConfirmedStepIds.add(step.id);
    }
  });

  let dependencyIssueCount = 0;
  steps.forEach((step) => {
    step.dependencies.forEach((depId) => {
      if (!byId.has(depId)) dependencyIssueCount += 1;
    });
  });

  const conflictCount = process.mergeReport?.conflicts.length ?? 0;
  const confirmedCount = steps.filter((step) => step.status === 'confirmed').length;
  const effectiveConfirmedCount = confirmedCount - staleConfirmedStepIds.size;
  const pendingReviewCount = steps.filter((step) => step.status === 'submitted' || step.status === 'returned').length;
  const reviewProgress = steps.length ? Math.round((confirmedCount / steps.length) * 100) : 0;

  const checks = [
    {
      label: '所有步骤已确认且未过期',
      detail: staleConfirmedStepIds.size
        ? `${staleConfirmedStepIds.size} 个确认需因上游变更重算（${effectiveConfirmedCount}/${steps.length} 有效）`
        : `${confirmedCount}/${steps.length}`,
      passed: confirmedCount === steps.length && staleConfirmedStepIds.size === 0
    },
    {
      label: '安全信息完整',
      detail: missingSafetySteps.length ? `${missingSafetySteps.length} 个缺口` : '无缺口',
      passed: missingSafetySteps.length === 0
    },
    {
      label: '依赖引用有效',
      detail: dependencyIssueCount ? `${dependencyIssueCount} 条悬空依赖` : `${steps.reduce((sum, step) => sum + step.dependencies.length, 0)} 条依赖`,
      passed: dependencyIssueCount === 0
    },
    {
      label: '合并冲突已全部人工裁决',
      detail: conflictCount ? `${conflictCount} 条待裁决` : '无待裁决冲突',
      passed: conflictCount === 0
    }
  ];

  const canFreeze = process.status !== 'frozen' && checks.every((check) => check.passed);

  return {
    missingSafetySteps,
    staleConfirmedStepIds,
    dependencyValid: dependencyIssueCount === 0,
    dependencyIssueCount,
    conflictCount,
    confirmedCount,
    effectiveConfirmedCount,
    pendingReviewCount,
    reviewProgress,
    canFreeze,
    freezeChecks: checks
  };
}
