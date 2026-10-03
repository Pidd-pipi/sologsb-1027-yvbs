import { clone, uid } from './derive';
import type { ExperimentProcess } from './types';

export type DemoVariant = 'standard' | 'diverged';

function attachBranch(process: ExperimentProcess, branchId: string, label: string, base: ExperimentProcess, baseVersionId: string, baseAt: string): ExperimentProcess {
  process.sync = {
    branchId,
    branchLabel: label,
    baseVersionId,
    baseAt,
    base: clone(base),
    mergedFrom: []
  };
  process.mergeReport = null;
  process.updatedAt = new Date().toISOString();
  return process;
}

function frozenBaseFrom(seed: ExperimentProcess, versionId: string): ExperimentProcess {
  const snapshot = seed.versions.find((version) => version.id === versionId) ?? seed.versions.at(-1)!;
  return {
    ...clone(seed),
    status: 'frozen',
    version: snapshot.version,
    frozenAt: snapshot.createdAt,
    steps: clone(snapshot.steps),
    versions: clone(seed.versions),
    mergeReport: null,
    updatedAt: snapshot.createdAt
  };
}

/**
 * 构造“两个页签断网续写同一冻结版”的一对草稿。
 * 返回的 local 会重置当前页签（仅演示），remote 用于合并。
 */
export function buildDemoPair(seedInput: ExperimentProcess, variant: DemoVariant): { local: ExperimentProcess; remote: ExperimentProcess } {
  const seed = clone(seedInput);
  // 统一把锚点收敛到 1.1.0 冻结版，保证能识别共同祖先
  const anchorVersion = seed.versions.find((version) => version.version === '1.1.0') ?? seed.versions.at(-1)!;
  const base = frozenBaseFrom(seed, anchorVersion.id);

  if (variant === 'diverged') {
    // 本页：已从 1.1.0 拉出修订并继续改
    const local = attachBranch(clone(base), seed.sync?.branchId ?? uid('branch'), '研究页签（1.2 修订）', base, anchorVersion.id, anchorVersion.createdAt);
    local.status = 'revising';
    local.version = '1.2.0-draft';
    local.frozenAt = undefined;
    local.steps.forEach((step) => {
      if (step.status === 'confirmed') step.status = 'submitted';
    });
    const l4 = local.steps.find((step) => step.id === 'step-4');
    if (l4) {
      l4.safetyNote = `${l4.safetyNote}（本页 1.2 修订：取样间隔从 15 分钟调整为 10 分钟。）`;
      l4.contentUpdatedAt = new Date().toISOString();
    }

    // 对端：仍基于旧冻结版 1.0.0 续写（该基线已被 1.1.0/1.2 修订取代）
    const oldVersion = seed.versions.find((version) => version.version === '1.0.0') ?? anchorVersion;
    const oldBase = frozenBaseFrom(seed, oldVersion.id);
    const remote = attachBranch(clone(oldBase), uid('branch'), '复核页签（基于旧冻结版）', oldBase, oldVersion.id, oldVersion.createdAt);
    remote.status = 'revising';
    remote.version = '1.0.1-复核修订';
    remote.frozenAt = undefined;
    const r3 = remote.steps.find((step) => step.id === 'step-3');
    if (r3) {
      r3.controls = `${r3.controls} 对端追加：催化剂称量后静置平衡 5 分钟再投料。`;
      r3.contentUpdatedAt = new Date().toISOString();
    }
    return { local, remote };
  }

  // standard：共同基线下，单边改动 + 同字段冲突 + 同批注两边修改
  const local = attachBranch(clone(base), seed.sync?.branchId ?? uid('branch'), '研究页签', base, anchorVersion.id, anchorVersion.createdAt);
  local.status = 'in-review';
  local.version = '1.2.0-draft';
  local.frozenAt = undefined;
  const now = new Date().toISOString();

  // 本页断网续写
  const l2 = local.steps.find((step) => step.id === 'step-2');
  if (l2) {
    l2.controls = `${l2.controls} 本页修订：超温断电阈值设定为 65 ℃。`;
    l2.contentUpdatedAt = now;
  }
  const l3 = local.steps.find((step) => step.id === 'step-3');
  if (l3) {
    // 依赖变化：下游确认立即重算
    if (!l3.dependencies.includes('step-1')) l3.dependencies = [...l3.dependencies, 'step-1'];
    l3.contentUpdatedAt = now;
    // 本页先加一条批注（对端也会改同一条 → 批注冲突）
    l3.comments.push({
      id: 'demo-shared-comment',
      author: '李明',
      role: '研究员',
      text: '本页批注：加料口密封圈已更换。',
      createdAt: now,
      resolved: false
    });
  }

  // 对端断网续写（同一基线分叉）
  const remote = attachBranch(clone(base), uid('branch'), '复核页签（断网续写）', base, anchorVersion.id, anchorVersion.createdAt);
  remote.status = 'in-review';
  remote.version = '1.2.0-draft';
  remote.frozenAt = undefined;

  // 流程级单边改动：直接接上
  remote.objective = `${remote.objective}（对端补充：复核要求全程留存温控曲线。）`;

  const r2 = remote.steps.find((step) => step.id === 'step-2');
  if (r2) {
    // 同一步骤两边都改同字段：冲突
    r2.controls = `${r2.controls} 对端修订：试压时长延长到 10 分钟，双人签字确认。`;
  }

  const r3 = remote.steps.find((step) => step.id === 'step-3');
  if (r3) {
    // 单边字段改动直接接上
    r3.amount = '催化剂 A 2.50 ± 0.01 g（对端收窄称量公差）';
    r3.status = 'submitted';
    r3.comments.push({
      id: uid('comment'),
      author: '周宁',
      role: '安全复核员',
      text: '对端批注：称量公差建议收窄到 ±0.01 g，并留存天平记录。',
      createdAt: now,
      resolved: false
    });
    // 同一条批注两边都改：批注冲突
    r3.comments.push({
      id: 'demo-shared-comment',
      author: '李明',
      role: '研究员',
      text: '对端改写的同一条批注：请在投料前拍照留存密封圈批次。',
      createdAt: now,
      resolved: false
    });
  }

  // 对端单边新增步骤
  const newStep = {
    id: uid('step'),
    title: '对端补步骤：复核投料前双人确认',
    purpose: '投料前由研究员与复核员双人核对催化剂批号、公差与防护。',
    materials: '催化剂 A、批号记录表',
    equipment: '分析天平、记录仪',
    amount: '按批次记录',
    duration: 10,
    hazards: ['粉尘吸入'],
    controls: '通风柜内操作，双人签字后方可投料。',
    dependencies: ['step-2'],
    safetyNote: '任一人未到岗不得开始投料。',
    expectedResult: '双人确认单签字完整。',
    status: 'draft' as const,
    comments: [],
    contentUpdatedAt: now
  };
  const index = remote.steps.findIndex((step) => step.id === 'step-3');
  remote.steps.splice(index >= 0 ? index + 1 : remote.steps.length, 0, newStep);

  return { local, remote };
}
