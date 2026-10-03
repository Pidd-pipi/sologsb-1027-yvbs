import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  Button,
  Callout,
  Card,
  Checkbox,
  Divider,
  Elevation,
  FormGroup,
  HTMLSelect,
  Icon,
  InputGroup,
  ProgressBar,
  Tab,
  Tabs,
  Tag,
  TextArea
} from '@blueprintjs/core';
import type {
  ConflictChoice,
  ExperimentProcess,
  HistoryState,
  PeerDraft,
  PendingMerge,
  ProcessStatus,
  ProcessStep,
  ReviewComment,
  StepStatus,
  VersionSnapshot,
  ViewId
} from './lib/types';
import {
  clone,
  collectDownstream,
  deriveReviewState,
  hasMissingSafety,
  isStepContentKey,
  uid
} from './lib/derive';
import { mergeProcesses, resolveConflict, clearReportIfResolved } from './lib/merge';
import {
  absorbPeer,
  exportDraft,
  getAbsorbedNotice,
  importDraft,
  initBranch,
  listPeerDrafts,
  listPendingMerges,
  loadDraft,
  notifyPeers,
  removePendingMerge,
  saveDraft,
  savePendingMerge,
  subscribePeerEvents
} from './lib/syncStore';
import { buildDemoPair } from './lib/demo';
import MergeCenter from './components/MergeCenter';

const CURRENT_AUTHOR = '周宁';
const CURRENT_ROLE = '安全复核员';
/** 种子数据里已确认步骤的“确认时刻”，早于任何当前编辑，避免首次载入就误报过期 */
const SEED_CONFIRMED_AT = '2026-09-24T16:00:00+08:00';

function initialProcess(): ExperimentProcess {
  const baseSteps: ProcessStep[] = [
    {
      id: 'step-1', title: '核对试剂与实验区域', purpose: '确认所需物料、设备及区域状态符合实验方案。',
      materials: '无水乙醇、去离子水', equipment: '通风柜、防爆柜、标签打印机', amount: '乙醇 120 mL；去离子水 300 mL',
      duration: 15, hazards: ['易燃液体'], controls: '在通风柜内取用，远离点火源；使用接地金属容器。',
      dependencies: [], safetyNote: '操作人员需佩戴护目镜和防化手套。', expectedResult: '试剂标签、数量和有效期均核对无误。',
      status: 'confirmed', comments: [
        { id: 'c-1', author: '李明', role: '研究员', text: '已核对批号和有效期，防爆柜温度记录正常。', createdAt: '2026-09-24T09:10:00+08:00', resolved: true }
      ]
    },
    {
      id: 'step-2', title: '搭建恒温循环装置', purpose: '连接循环浴与反应夹套，检查密封和温控。',
      materials: '无', equipment: '恒温循环浴、硅胶管、反应夹套、扎带', amount: '循环液 800 mL',
      duration: 25, hazards: ['烫伤', '管路脱落'], controls: '管路双端固定；升温前完成 5 分钟试压并设置独立超温断电。',
      dependencies: ['step-1'], safetyNote: '高温表面设置警示标识，循环浴周围保持干燥。', expectedResult: '30 分钟内温度稳定在 55 ± 0.5 ℃。',
      status: 'confirmed', comments: [
        { id: 'c-2', author: '王颖', role: '安全复核员', text: '补充超温断电值，不能只依赖设备自带温控。', createdAt: '2026-09-24T10:05:00+08:00', resolved: true }
      ]
    },
    {
      id: 'step-3', title: '加入催化剂并启动反应', purpose: '按批次加入催化剂，记录起点并开始计时。',
      materials: '催化剂 A', equipment: '分析天平、加料漏斗、计时器', amount: '催化剂 A 2.50 ± 0.02 g',
      duration: 20, hazards: ['粉尘吸入', '放热反应'], controls: '在通风柜内称量，佩戴 N95 口罩；分三次少量加入并监测温度。',
      dependencies: ['step-2'], safetyNote: '反应温度超过 70 ℃ 时立即停止加料并启动冷却。', expectedResult: '温度缓慢升至 62–66 ℃，无明显冲料。',
      status: 'submitted', comments: []
    },
    {
      id: 'step-4', title: '恒温反应与过程取样', purpose: '维持温度并定时取样观察反应转化。',
      materials: '样品瓶、惰性气体', equipment: '取样针、气相色谱、恒温循环浴', amount: '每点样品约 1 mL，共 6 点',
      duration: 90, hazards: ['高温液体', '挥发性气体'], controls: '取样前泄压；使用长针和防护屏；样品瓶及时封闭。',
      dependencies: ['step-3'], safetyNote: '取样时不得正对瓶口，样品瓶不得完全密封后加热。', expectedResult: '转化率达到 95% 以上且无异常副产物。',
      status: 'submitted', comments: []
    },
    {
      id: 'step-5', title: '停止加热并冷却', purpose: '终止反应并将体系降至安全温度。',
      materials: '无', equipment: '循环浴、温度探头', amount: '降温目标 ≤ 30 ℃', duration: 35,
      hazards: ['烫伤', '残余反应'], controls: '先停止加料并维持搅拌，再以不超过 1 ℃/min 的速率降温。',
      dependencies: ['step-4'], safetyNote: '确认温度连续 5 分钟低于 30 ℃ 后才能拆除装置。', expectedResult: '体系温度稳定低于 30 ℃。',
      status: 'draft', comments: []
    },
    {
      id: 'step-6', title: '废液分类与现场恢复', purpose: '按危险废物要求分类收集并恢复实验区域。',
      materials: '废液桶、吸附棉', equipment: '防化手套、护目镜、危废标签', amount: '按实际产生量记录', duration: 25,
      hazards: ['废液混装', '化学暴露'], controls: '有机废液单独收集，核对相容性后贴标签；泄漏吸附材料按危废处置。',
      dependencies: ['step-5'], safetyNote: '废液不得倒入下水道，现场恢复后完成双人确认。', expectedResult: '废液交接记录完整，台面无残留。',
      status: 'draft', comments: []
    }
  ];
  baseSteps.forEach((step) => {
    if (step.status === 'confirmed') {
      step.contentUpdatedAt = SEED_CONFIRMED_AT;
      step.confirmedAt = SEED_CONFIRMED_AT;
    }
  });

  const firstVersion: VersionSnapshot = {
    id: 'version-1-0', label: '首版批准流程', version: '1.0.0', createdAt: '2026-09-20T14:30:00+08:00',
    note: '建立基础反应与取样步骤。', author: '王颖',
    steps: clone(baseSteps).slice(0, 4).map((step) => ({ ...step, status: 'confirmed' as const, comments: [], contentUpdatedAt: SEED_CONFIRMED_AT, confirmedAt: SEED_CONFIRMED_AT }))
  };
  const secondVersion: VersionSnapshot = {
    id: 'version-1-1', label: '补充冷却与废液步骤', version: '1.1.0', createdAt: '2026-09-24T15:10:00+08:00',
    note: '增加安全冷却、废液处置和现场恢复。', author: '王颖',
    steps: clone(baseSteps).map((step) => ({ ...step, status: 'confirmed' as const, comments: [], contentUpdatedAt: SEED_CONFIRMED_AT, confirmedAt: SEED_CONFIRMED_AT }))
  };

  const draft: ExperimentProcess = {
    id: 'exp-catalyst-2026-09', title: '负载型催化剂评价实验', code: 'SAFE-CAT-026',
    objective: '在受控温度下评价催化剂活性，并完整记录过程样品与安全控制措施。',
    principal: '李明', lab: '材料化学实验室 B-207',
    status: 'in-review', version: '1.2.0-draft',
    steps: baseSteps, versions: [firstVersion, secondVersion], updatedAt: new Date().toISOString()
  };

  const boot: ExperimentProcess = {
    ...draft,
    sync: {
      branchId: 'branch-seed',
      branchLabel: '研究页签',
      baseVersionId: secondVersion.id,
      baseAt: secondVersion.createdAt,
      base: {
        ...clone(draft),
        status: 'frozen',
        version: secondVersion.version,
        frozenAt: secondVersion.createdAt,
        steps: clone(secondVersion.steps),
        versions: [],
        mergeReport: null,
        updatedAt: secondVersion.createdAt
      },
      mergedFrom: []
    }
  };
  return boot;
}

function migrate(process: ExperimentProcess): ExperimentProcess {
  const migrated = clone(process);
  migrated.steps.forEach((step) => {
    if (step.status === 'confirmed' && step.contentUpdatedAt === undefined) {
      step.contentUpdatedAt = SEED_CONFIRMED_AT;
    }
    if (step.status === 'confirmed' && step.confirmedAt === undefined) {
      step.confirmedAt = step.contentUpdatedAt ?? SEED_CONFIRMED_AT;
    }
  });
  return migrated;
}

function historyReducer(state: HistoryState, action:
  | { type: 'commit'; update: (draft: ExperimentProcess) => void }
  | { type: 'merge-result'; value: ExperimentProcess }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset'; value: ExperimentProcess }
): HistoryState {
  if (action.type === 'commit') {
    const next = clone(state.present);
    action.update(next);
    next.updatedAt = new Date().toISOString();
    return { past: [...state.past.slice(-59), clone(state.present)], present: next, future: [] };
  }
  if (action.type === 'merge-result') {
    return { past: [...state.past.slice(-59), clone(state.present)], present: clone(action.value), future: [] };
  }
  if (action.type === 'undo') {
    const previous = state.past.at(-1);
    if (!previous) return state;
    return { past: state.past.slice(0, -1), present: previous, future: [clone(state.present), ...state.future].slice(0, 60) };
  }
  if (action.type === 'redo') {
    const next = state.future[0];
    if (!next) return state;
    return { past: [...state.past, clone(state.present)].slice(-60), present: next, future: state.future.slice(1) };
  }
  return { past: [], present: action.value, future: [] };
}

function bootstrapProcess(): { process: ExperimentProcess; branchId: string; label: string } {
  const seeded = migrate(initialProcess());
  const { branchId, label } = initBranch(seeded);
  const stored = loadDraft(branchId);
  const process = stored ? migrate(stored) : seeded;
  if (process.sync) {
    process.sync.branchId = branchId;
    process.sync.branchLabel = label;
  }
  if (!stored) saveDraft(branchId, label, process);
  return { process, branchId, label };
}

function splitList(value: string): string[] {
  return value.split(/[\n,，、;；]+/).map((item) => item.trim()).filter(Boolean);
}

function statusLabel(status: StepStatus): string {
  return status === 'confirmed' ? '已确认' : status === 'returned' ? '已退回' : status === 'submitted' ? '待复核' : '草稿';
}

function processStatusLabel(status: ProcessStatus): string {
  return status === 'frozen' ? '已冻结' : status === 'in-review' ? '复核中' : status === 'revising' ? '修订中' : '草稿';
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date);
}

function nextMinorVersion(value: string): string {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return '1.2.0';
  return `${match[1]}.${Number(match[2]) + 1}.0`;
}

interface DiffItem {
  id: string;
  title: string;
  kind: 'added' | 'removed' | 'changed';
  detail: string;
}

function compareVersions(process: ExperimentProcess, baseId: string, targetId: string): DiffItem[] {
  const base = process.versions.find((version) => version.id === baseId);
  const target = process.versions.find((version) => version.id === targetId);
  if (!base || !target) return [];
  const diffs: DiffItem[] = [];
  const targetMap = new Map(target.steps.map((step) => [step.id, step]));
  const baseMap = new Map(base.steps.map((step) => [step.id, step]));
  base.steps.forEach((step) => {
    if (!targetMap.has(step.id)) diffs.push({ id: step.id, title: step.title, kind: 'removed', detail: '目标版本已删除该步骤。' });
  });
  target.steps.forEach((step) => {
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

function App() {
  const bootRef = useRef<{ process: ExperimentProcess; branchId: string; label: string } | null>(null);
  if (!bootRef.current) bootRef.current = bootstrapProcess();
  const [history, dispatch] = useReducer(historyReducer, undefined, () => ({
    past: [], present: bootRef.current!.process, future: []
  }));
  const branchId = bootRef.current.branchId;
  const branchLabel = bootRef.current.label;
  const process = history.present;

  const [selectedStepId, setSelectedStepId] = useState(process.steps[0]?.id ?? '');
  const [activeView, setActiveView] = useState<ViewId>('editor');
  const [lastModifiedId, setLastModifiedId] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [savedLabel, setSavedLabel] = useState('本地草稿已载入');
  const [online, setOnline] = useState(true);
  const [peers, setPeers] = useState<PeerDraft[]>([]);
  const [pendingMerges, setPendingMerges] = useState<PendingMerge[]>([]);
  const [failMode, setFailMode] = useState(false);
  const [lastMergeError, setLastMergeError] = useState<string | null>(null);
  const [absorbedNotice, setAbsorbedNotice] = useState<string | null>(null);
  const [compareBaseId, setCompareBaseId] = useState(process.versions[0]?.id ?? '');
  const [compareTargetId, setCompareTargetId] = useState(process.versions.at(-1)?.id ?? '');
  const initialSaveSkipped = useRef(false);

  const selectedStep = process.steps.find((step) => step.id === selectedStepId) ?? process.steps[0];
  const derived = useMemo(() => deriveReviewState(process), [process]);
  const downstreamIds = useMemo(() => collectDownstream(process.steps, lastModifiedId), [process.steps, lastModifiedId]);
  const impactedSteps = process.steps.filter((step) => downstreamIds.includes(step.id));
  const versionDiff = useMemo(() => compareVersions(process, compareBaseId, compareTargetId), [process, compareBaseId, compareTargetId]);

  // 草稿按分支键持久化，多页签不再互相覆盖
  useEffect(() => {
    if (!initialSaveSkipped.current) {
      initialSaveSkipped.current = true;
      return;
    }
    saveDraft(branchId, branchLabel, process);
    setSavedLabel(`自动保存 · ${formatDate(new Date().toISOString())}`);
    notifyPeers(branchId, branchLabel);
  }, [process, branchId, branchLabel]);

  const refreshPeers = () => {
    setPeers(listPeerDrafts(branchId));
    setPendingMerges(listPendingMerges());
    const notice = getAbsorbedNotice(branchId);
    if (notice) setAbsorbedNotice(notice.byLabel);
  };

  useEffect(() => {
    refreshPeers();
    const unsubscribe = subscribePeerEvents(refreshPeers);
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      if (!modifier) return;
      if (event.key.toLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? dispatch({ type: 'redo' }) : dispatch({ type: 'undo' });
      } else if (event.key.toLowerCase() === 'y') {
        event.preventDefault();
        dispatch({ type: 'redo' });
      } else if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveDraft(branchId, branchLabel, process);
        notifyPeers(branchId, branchLabel);
        setSavedLabel(`手动保存 · ${formatDate(new Date().toISOString())}`);
      }
    };
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, [process, branchId, branchLabel]);

  const commitProcess = (update: (draft: ExperimentProcess) => void): void => {
    dispatch({ type: 'commit', update });
  };

  const updateProcessField = (field: 'title' | 'code' | 'objective' | 'principal' | 'lab', value: string): void => {
    commitProcess((draft) => { draft[field] = value; });
  };

  const updateStep = (field: keyof ProcessStep, value: unknown): void => {
    if (!selectedStep || process.status === 'frozen') return;
    const id = selectedStep.id;
    const now = new Date().toISOString();
    setLastModifiedId(id);
    commitProcess((draft) => {
      const step = draft.steps.find((item) => item.id === id);
      if (!step) return;
      (step as unknown as Record<string, unknown>)[field] = value;
      // 步骤、依赖或危险项等内容一变：标记内容时间，下游确认立即重算（派生层读取）
      if (isStepContentKey(field)) step.contentUpdatedAt = now;
    });
  };

  const updateStepList = (field: 'hazards' | 'dependencies', value: string): void => {
    updateStep(field, splitList(value));
  };

  const addStep = (): void => {
    if (process.status === 'frozen') return;
    const id = uid('step');
    commitProcess((draft) => {
      draft.steps.push({
        id, title: '新的实验步骤', purpose: '', materials: '', equipment: '', amount: '', duration: 10,
        hazards: [], controls: '', dependencies: draft.steps.at(-1) ? [draft.steps.at(-1)!.id] : [],
        safetyNote: '', expectedResult: '', status: 'draft', comments: [],
        contentUpdatedAt: new Date().toISOString()
      });
      draft.status = 'draft';
    });
    setSelectedStepId(id);
    setLastModifiedId(id);
    setActiveView('editor');
  };

  const duplicateStep = (): void => {
    if (!selectedStep || process.status === 'frozen') return;
    const copy: ProcessStep = clone(selectedStep);
    copy.id = uid('step');
    copy.title = `${copy.title}（副本）`;
    copy.status = 'draft';
    copy.comments = [];
    copy.dependencies = [...copy.dependencies];
    copy.contentUpdatedAt = new Date().toISOString();
    commitProcess((draft) => {
      const index = draft.steps.findIndex((step) => step.id === selectedStep.id);
      draft.steps.splice(index + 1, 0, copy);
    });
    setSelectedStepId(copy.id);
  };

  const deleteStep = (): void => {
    if (!selectedStep || process.steps.length <= 1 || process.status === 'frozen') return;
    const id = selectedStep.id;
    commitProcess((draft) => {
      draft.steps = draft.steps.filter((step) => step.id !== id);
      draft.steps.forEach((step) => { step.dependencies = step.dependencies.filter((dependency) => dependency !== id); });
    });
    setSelectedStepId(process.steps.find((step) => step.id !== id)?.id ?? '');
  };

  const moveStep = (direction: -1 | 1): void => {
    if (!selectedStep || process.status === 'frozen') return;
    const id = selectedStep.id;
    commitProcess((draft) => {
      const index = draft.steps.findIndex((step) => step.id === id);
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= draft.steps.length) return;
      const [step] = draft.steps.splice(index, 1);
      draft.steps.splice(nextIndex, 0, step);
    });
    setLastModifiedId(id);
  };

  const toggleDependency = (dependencyId: string, checked: boolean): void => {
    if (!selectedStep) return;
    const next = checked
      ? [...new Set([...selectedStep.dependencies, dependencyId])]
      : selectedStep.dependencies.filter((id) => id !== dependencyId);
    updateStep('dependencies', next);
  };

  const submitForReview = (): void => {
    if (process.status === 'frozen') return;
    commitProcess((draft) => {
      draft.status = 'in-review';
      draft.steps.forEach((step) => {
        if (step.status !== 'confirmed') step.status = 'submitted';
      });
    });
    setActiveView('review');
    setSavedLabel('流程已提交复核');
  };

  const addReviewComment = (): void => {
    if (!selectedStep || !commentText.trim()) return;
    const id = selectedStep.id;
    commitProcess((draft) => {
      const step = draft.steps.find((item) => item.id === id);
      step?.comments.push({
        id: uid('comment'), author: CURRENT_AUTHOR, role: CURRENT_ROLE,
        text: commentText.trim(), createdAt: new Date().toISOString(), resolved: false
      } as ReviewComment);
    });
    setCommentText('');
  };

  const setStepStatus = (status: StepStatus): void => {
    if (!selectedStep) return;
    const id = selectedStep.id;
    const now = new Date().toISOString();
    commitProcess((draft) => {
      const step = draft.steps.find((item) => item.id === id);
      if (!step) return;
      step.status = status;
      // 确认/退回不改内容、不触发下游重算；记录确认时刻供过期判定
      if (status === 'confirmed') step.confirmedAt = now;
    });
    setLastModifiedId(status === 'returned' ? id : null);
  };

  const freezeVersion = (): void => {
    if (!derived.canFreeze) {
      setSavedLabel('冻结条件未满足');
      return;
    }
    const nextNumber = nextMinorVersion(process.version);
    const previousVersionId = process.versions.at(-1)?.id ?? '';
    const frozenVersionId = uid('version');
    commitProcess((draft) => {
      const frozenSteps = clone(draft.steps).map((step) => ({
        ...step,
        status: 'confirmed' as const,
        contentUpdatedAt: new Date().toISOString(),
        confirmedAt: new Date().toISOString()
      }));
      draft.versions.push({
        id: frozenVersionId, label: '复核通过冻结版', version: nextNumber,
        createdAt: new Date().toISOString(), note: `${draft.steps.length} 个步骤全部确认，安全控制完整。`,
        author: CURRENT_AUTHOR, steps: frozenSteps
      });
      draft.version = nextNumber;
      draft.status = 'frozen';
      draft.frozenAt = new Date().toISOString();
      draft.mergeReport = null;
      if (draft.sync) {
        draft.sync.baseVersionId = frozenVersionId;
        draft.sync.baseAt = new Date().toISOString();
        draft.sync.base = clone(draft);
      }
    });
    setSavedLabel(`版本 ${nextNumber} 已冻结`);
    setCompareBaseId(previousVersionId);
    setCompareTargetId(frozenVersionId);
  };

  const startRevision = (): void => {
    if (process.status !== 'frozen') return;
    commitProcess((draft) => {
      const nextNumber = nextMinorVersion(draft.version);
      draft.version = `${nextNumber}-revision`;
      draft.status = 'revising';
      draft.frozenAt = undefined;
      draft.steps.forEach((step) => {
        step.status = 'draft';
        step.comments = [];
        step.contentUpdatedAt = new Date().toISOString();
        step.confirmedAt = undefined;
      });
    });
    setActiveView('editor');
    setSavedLabel('已从冻结版本创建修订稿');
  };

  const addVersionSnapshot = (): void => {
    commitProcess((draft) => {
      draft.versions.push({
        id: uid('version'), label: '工作版本快照', version: draft.version.replace('-draft', ''),
        createdAt: new Date().toISOString(), note: '保存当前步骤与复核状态。',
        author: CURRENT_AUTHOR, steps: clone(draft.steps)
      });
    });
    setSavedLabel('已保存工作版本快照');
  };

  // —— 离线合并 ——
  const runMerge = (remote: ExperimentProcess, remoteLabel: string, failSimulation: boolean): void => {
    const pendingId = uid('pending');
    try {
      const { process: merged } = mergeProcesses(process, remote, {
        localLabel: branchLabel,
        remoteLabel,
        simulateFailure: failSimulation
      });
      dispatch({ type: 'merge-result', value: merged });
      setActiveView('merge');
      setLastMergeError(null);
      const peer = peers.find((item) => item.process === remote || item.branchId === remote.sync?.branchId);
      if (peer) {
        absorbPeer(branchId, branchLabel, peer);
      }
      setSavedLabel(`已合并 ${remoteLabel} · ${merged.mergeReport?.conflicts.length ?? 0} 条待裁决`);
      setTimeout(refreshPeers, 0);
    } catch (error) {
      // 处理失败：原草稿保留（没有 dispatch），登记待重试
      const message = error instanceof Error ? error.message : '未知合并错误';
      setLastMergeError(message);
      const pending: PendingMerge = {
        id: pendingId, at: new Date().toISOString(), remoteLabel, remote: clone(remote),
        failMode: failSimulation, message
      };
      savePendingMerge(pending);
      setPendingMerges(listPendingMerges());
    }
  };

  const handleMergePeer = (peer: PeerDraft): void => {
    runMerge(peer.process, peer.label, failMode);
    if (failMode) setFailMode(false);
  };

  const handleImportRemote = (raw: string): void => {
    try {
      const remote = importDraft(raw);
      const label = remote.sync?.branchLabel ?? `导入草稿 ${formatDate(new Date().toISOString())}`;
      runMerge(remote, label, failMode);
      if (failMode) setFailMode(false);
    } catch (error) {
      setLastMergeError(error instanceof Error ? error.message : '草稿解析失败');
    }
  };

  const handleExportRemote = (): void => {
    const content = exportDraft(process);
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${process.code}-${branchLabel}-draft.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handleSeedDemo = (variant: 'standard' | 'diverged'): void => {
    let pair: { local: ExperimentProcess; remote: ExperimentProcess };
    try {
      pair = buildDemoPair(process, variant);
    } catch (error) {
      setLastMergeError(error instanceof Error ? error.message : '演示场景构造失败');
      return;
    }
    try {
      // 先在内存里算好结果：成功才替换草稿，失败则当前页草稿原封不动
      const result = mergeProcesses(pair.local, pair.remote, {
        localLabel: pair.local.sync?.branchLabel,
        remoteLabel: pair.remote.sync?.branchLabel,
        simulateFailure: failMode
      });
      dispatch({ type: 'merge-result', value: result.process });
      setActiveView('merge');
      setSavedLabel(`演示合并完成 · ${result.report.conflicts.length} 条待裁决`);
      setFailMode(false);
    } catch (error) {
      // 处理失败：当前草稿保留，登记可重试记录
      setLastMergeError(error instanceof Error ? error.message : '演示合并失败');
      savePendingMerge({
        id: uid('pending'), at: new Date().toISOString(), remoteLabel: pair.remote.sync?.branchLabel ?? '演示对端',
        remote: clone(pair.remote), failMode: failMode, message: error instanceof Error ? error.message : '演示合并失败'
      });
      setPendingMerges(listPendingMerges());
      setFailMode(false);
    }
  };

  const handleResolve = (conflictId: string, choice: ConflictChoice): void => {
    try {
      let next = resolveConflict(process, conflictId, choice);
      next = clearReportIfResolved(next);
      dispatch({ type: 'merge-result', value: next });
      setSavedLabel('冲突已裁决');
    } catch (error) {
      // 裁决处理失败：保留当前草稿，允许重试
      setLastMergeError(error instanceof Error ? error.message : '裁决失败，请重试');
    }
  };

  const handleRetryPending = (pending: PendingMerge): void => {
    try {
      const { process: merged } = mergeProcesses(process, pending.remote, {
        localLabel: branchLabel,
        remoteLabel: pending.remoteLabel,
        simulateFailure: false
      });
      dispatch({ type: 'merge-result', value: merged });
      removePendingMerge(pending.id);
      setPendingMerges(listPendingMerges());
      setLastMergeError(null);
      setSavedLabel(`重试成功 · 已合并 ${pending.remoteLabel}`);
    } catch (error) {
      setLastMergeError(error instanceof Error ? error.message : '重试仍失败，草稿未改动');
    }
  };

  const handleDiscardPending = (id: string): void => {
    removePendingMerge(id);
    setPendingMerges(listPendingMerges());
  };

  const dismissReport = (): void => {
    commitProcess((draft) => {
      draft.mergeReport = null;
    });
  };

  const pendingBadge = derived.pendingReviewCount;
  const conflictCount = derived.conflictCount;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-block">
          <div className="brand-icon"><Icon icon="lab-test" size={23} /></div>
          <div><h1>实验流程安全复核台</h1><p>步骤影响分析 · 逐条复核 · 离线分支合并 · 冻结版本</p></div>
        </div>
        <div className="header-status">
          <span className={`network ${online ? 'online' : ''}`}></span>
          <span>{online ? '离线保存已启用' : '当前离线，修改仍会保存'}</span>
          <Tag minimal className="branch-tag">{branchLabel}</Tag>
          <strong>{savedLabel}</strong>
        </div>
        <div className="header-actions">
          <Button icon="undo" text="撤销" minimal disabled={history.past.length === 0} onClick={() => dispatch({ type: 'undo' })} />
          <Button icon="redo" text="重做" minimal disabled={history.future.length === 0} onClick={() => dispatch({ type: 'redo' })} />
          <Button icon="floppy-disk" text="保存快照" onClick={addVersionSnapshot} />
          <Button icon="lock" text="冻结版本" intent="primary" onClick={freezeVersion} disabled={!derived.canFreeze} />
        </div>
      </header>

      {!online && <Callout className="offline-callout" intent="warning" icon="cloud">网络不可用。编辑、复核和版本快照仍会按页签分支保存在当前浏览器，不会覆盖另一页签。</Callout>}
      {conflictCount > 0 && (
        <Callout className="offline-callout" intent="danger" icon="git-merge" onClick={() => setActiveView('merge')} style={{ cursor: 'pointer' }}>
          有 {conflictCount} 条合并冲突待人工裁决，裁决前无法冻结版本。点击前往「离线合并」。
        </Callout>
      )}
      {absorbedNotice && (
        <Callout className="offline-callout" intent="primary" icon="people">
          <div className="absorb-row">
            <span>本页草稿已被另一页签（{absorbedNotice}）合并吸收，继续编辑将作为新分支；如需查看合并结果请打开对方页签。</span>
            <Button minimal small icon="cross" onClick={() => setAbsorbedNotice(null)} />
          </div>
        </Callout>
      )}

      <section className="process-banner">
        <div className="banner-main">
          <div className="code-line"><span>{process.code}</span><Tag minimal>{processStatusLabel(process.status)}</Tag></div>
          <h2>{process.title}</h2>
          <p>{process.objective}</p>
        </div>
        <div className="banner-meta">
          <div><span>负责人</span><strong>{process.principal}</strong></div>
          <div><span>实验区域</span><strong>{process.lab}</strong></div>
          <div><span>当前版本</span><strong>{process.version}</strong></div>
        </div>
        <div className="banner-progress">
          <div><span>复核进度（有效确认）</span><strong>{derived.effectiveConfirmedCount}/{process.steps.length}</strong></div>
          <ProgressBar value={derived.reviewProgress / 100} intent={derived.staleConfirmedStepIds.size ? 'warning' : derived.reviewProgress === 100 ? 'success' : 'primary'} stripes={derived.reviewProgress < 100 || derived.staleConfirmedStepIds.size > 0} />
          <small>
            {pendingBadge ? `${pendingBadge} 条待处理` : '所有步骤已处理'} · {derived.missingSafetySteps.length} 条安全缺口
            {derived.staleConfirmedStepIds.size ? ` · ${derived.staleConfirmedStepIds.size} 个确认过期` : ''}
            {conflictCount ? ` · ${conflictCount} 条合并冲突` : ''}
          </small>
        </div>
      </section>

      <Tabs id="workspace-tabs" selectedTabId={activeView} onChange={(value) => setActiveView(value as ViewId)} renderActiveTabPanelOnly className="workspace-tabs">
        <Tab id="editor" title={<span><Icon icon="edit" /> 流程编写</span>} />
        <Tab id="review" title={<span><Icon icon="endorsed" /> 安全复核 {pendingBadge > 0 && <b className="tab-badge">{pendingBadge}</b>}</span>} />
        <Tab id="compare" title={<span><Icon icon="comparison" /> 版本比较</span>} />
        <Tab id="merge" title={<span><Icon icon="git-merge" /> 离线合并 {conflictCount > 0 && <b className="tab-badge">{conflictCount}</b>}</span>} />
      </Tabs>

      {activeView === 'editor' && selectedStep && (
        <main className="editor-layout">
          <aside className="step-panel">
            <div className="panel-heading">
              <div><span>PROCESS STEPS</span><h3>实验步骤</h3></div>
              <Button icon="add" minimal small onClick={addStep} disabled={process.status === 'frozen'} />
            </div>
            <div className="step-list">
              {process.steps.map((step, index) => (
                <button key={step.id} className={step.id === selectedStep.id ? 'selected' : ''} onClick={() => setSelectedStepId(step.id)}>
                  <span className={`step-number ${step.status}`}>{String(index + 1).padStart(2, '0')}</span>
                  <span className="step-copy"><strong>{step.title}</strong><small>{step.duration} 分钟 · {statusLabel(step.status)}{derived.staleConfirmedStepIds.has(step.id) ? ' · 确认过期' : ''}</small></span>
                  {hasMissingSafety(step)
                    ? <Icon icon="warning-sign" intent="danger" size={13} />
                    : derived.staleConfirmedStepIds.has(step.id)
                      ? <Icon icon="updated" intent="warning" size={13} />
                      : null}
                </button>
              ))}
            </div>
            <div className="step-actions">
              <Button icon="arrow-up" small minimal disabled={process.steps[0]?.id === selectedStep.id || process.status === 'frozen'} onClick={() => moveStep(-1)} />
              <Button icon="arrow-down" small minimal disabled={process.steps.at(-1)?.id === selectedStep.id || process.status === 'frozen'} onClick={() => moveStep(1)} />
              <Button icon="duplicate" small minimal text="复制" disabled={process.status === 'frozen'} onClick={duplicateStep} />
              <Button icon="trash" small minimal intent="danger" disabled={process.status === 'frozen'} onClick={deleteStep} />
            </div>
          </aside>

          <section className="editor-main">
            <Card elevation={Elevation.ONE} className="process-meta-card">
              <div className="card-title"><div><span>PROCESS INFO</span><h3>实验基本信息</h3></div><Tag minimal intent="primary">{process.steps.length} 个步骤</Tag></div>
              <div className="meta-grid">
                <FormGroup label="实验名称" labelFor="process-title"><InputGroup id="process-title" fill value={process.title} onChange={(event) => updateProcessField('title', event.target.value)} /></FormGroup>
                <FormGroup label="流程编号" labelFor="process-code"><InputGroup id="process-code" fill value={process.code} onChange={(event) => updateProcessField('code', event.target.value)} /></FormGroup>
                <FormGroup label="负责人" labelFor="principal"><InputGroup id="principal" fill value={process.principal} onChange={(event) => updateProcessField('principal', event.target.value)} /></FormGroup>
                <FormGroup label="实验区域" labelFor="lab"><InputGroup id="lab" fill value={process.lab} onChange={(event) => updateProcessField('lab', event.target.value)} /></FormGroup>
              </div>
              <FormGroup label="实验目标" labelFor="objective"><TextArea id="objective" fill value={process.objective} onChange={(event) => updateProcessField('objective', event.target.value)} /></FormGroup>
            </Card>

            <Card elevation={Elevation.ONE} className="step-editor-card">
              <div className="card-title">
                <div><span>STEP {String(process.steps.indexOf(selectedStep) + 1).padStart(2, '0')}</span><h3>{selectedStep.title}</h3></div>
                <div className="step-tags">
                  {derived.staleConfirmedStepIds.has(selectedStep.id) && <Tag minimal intent="warning" icon="updated">确认过期，需重算</Tag>}
                  <Tag minimal intent={selectedStep.status === 'confirmed' ? 'success' : selectedStep.status === 'returned' ? 'danger' : 'warning'}>{statusLabel(selectedStep.status)}</Tag>
                </div>
              </div>
              <FormGroup label="步骤名称" labelFor="step-title"><InputGroup id="step-title" fill value={selectedStep.title} onChange={(event) => updateStep('title', event.target.value)} /></FormGroup>
              <FormGroup label="操作目的" labelFor="step-purpose"><TextArea id="step-purpose" fill value={selectedStep.purpose} onChange={(event) => updateStep('purpose', event.target.value)} /></FormGroup>
              <div className="form-grid">
                <FormGroup label="材料" labelFor="materials"><TextArea id="materials" fill value={selectedStep.materials} onChange={(event) => updateStep('materials', event.target.value)} /></FormGroup>
                <FormGroup label="设备" labelFor="equipment"><TextArea id="equipment" fill value={selectedStep.equipment} onChange={(event) => updateStep('equipment', event.target.value)} /></FormGroup>
                <FormGroup label="用量 / 参数" labelFor="amount"><TextArea id="amount" fill value={selectedStep.amount} onChange={(event) => updateStep('amount', event.target.value)} /></FormGroup>
                <FormGroup label="预计时间（分钟）" labelFor="duration"><InputGroup id="duration" type="number" min={1} fill value={String(selectedStep.duration)} onChange={(event) => updateStep('duration', Number(event.target.value))} /></FormGroup>
              </div>
              <div className="form-grid two-column">
                <FormGroup label="危险项（逗号或换行分隔）" labelFor="hazards"><TextArea id="hazards" fill value={selectedStep.hazards.join('，')} onChange={(event) => updateStepList('hazards', event.target.value)} /></FormGroup>
                <FormGroup label="控制措施" labelFor="controls"><TextArea id="controls" fill value={selectedStep.controls} onChange={(event) => updateStep('controls', event.target.value)} /></FormGroup>
              </div>
              <FormGroup label="安全说明" labelFor="safety-note" helperText={hasMissingSafety(selectedStep) ? '存在危险项时，控制措施和安全说明均为必填。' : '安全说明已满足复核条件。'}>
                <TextArea id="safety-note" fill intent={hasMissingSafety(selectedStep) ? 'danger' : 'none'} value={selectedStep.safetyNote} onChange={(event) => updateStep('safetyNote', event.target.value)} />
              </FormGroup>
              <FormGroup label="预期结果" labelFor="expected"><TextArea id="expected" fill value={selectedStep.expectedResult} onChange={(event) => updateStep('expectedResult', event.target.value)} /></FormGroup>
            </Card>

            <Card elevation={Elevation.ONE} className="dependency-card">
              <div className="card-title"><div><span>DEPENDENCIES</span><h3>前置步骤</h3></div><Tag minimal>{selectedStep.dependencies.length} 个依赖</Tag></div>
              <p className="muted">当前步骤只有在所选前置步骤完成后才能进入执行队列；依赖变化会立即重算全部下游确认。</p>
              <div className="dependency-grid">
                {process.steps.filter((step) => step.id !== selectedStep.id).map((step) => (
                  <Checkbox key={step.id} checked={selectedStep.dependencies.includes(step.id)} label={`${String(process.steps.indexOf(step) + 1).padStart(2, '0')} · ${step.title}`} onChange={(event) => toggleDependency(step.id, event.currentTarget.checked)} />
                ))}
              </div>
            </Card>
          </section>

          <aside className="inspector-panel">
            <Card elevation={Elevation.ONE} className="impact-card">
              <div className="card-title"><div><span>IMPACT ANALYSIS</span><h3>变更影响提醒</h3></div><Icon icon="path-search" size={18} /></div>
              {lastModifiedId ? (
                <>
                  <Callout intent={impactedSteps.length ? 'warning' : 'primary'} icon={impactedSteps.length ? 'warning-sign' : 'tick'}>
                    <strong>{impactedSteps.length ? `${impactedSteps.length} 个后续步骤受影响` : '未发现下游步骤'}</strong>
                    <p>{impactedSteps.length ? '步骤、依赖或危险项变化，下游已确认内容立即标记过期需重新确认。' : '当前修改没有影响其他步骤的安全条件。'}</p>
                  </Callout>
                  <div className="impact-list">
                    {impactedSteps.map((step) => (
                      <button key={step.id} onClick={() => setSelectedStepId(step.id)}>
                        <Icon icon={derived.staleConfirmedStepIds.has(step.id) ? 'updated' : step.status === 'confirmed' ? 'endorsed' : 'circle'} intent={derived.staleConfirmedStepIds.has(step.id) ? 'warning' : step.status === 'confirmed' ? 'success' : 'none'} size={13} />
                        <span><strong>{step.title}</strong><small>{derived.staleConfirmedStepIds.has(step.id) ? '已确认内容过期，请重新确认' : step.status === 'confirmed' ? '已确认内容，需重新复核' : `当前状态：${statusLabel(step.status)}`}</small></span>
                        <Icon icon="chevron-right" size={12} />
                      </button>
                    ))}
                  </div>
                </>
              ) : <p className="muted">编辑任一步骤后，这里会显示受影响的所有后续步骤和已确认内容。</p>}
            </Card>

            <Card elevation={Elevation.ONE} className="safety-card">
              <div className="card-title"><div><span>SAFETY GATE</span><h3>安全完整性</h3></div><Tag intent={derived.missingSafetySteps.length ? 'danger' : 'success'} minimal>{derived.missingSafetySteps.length ? `${derived.missingSafetySteps.length} 项缺口` : '通过'}</Tag></div>
              {derived.missingSafetySteps.length ? derived.missingSafetySteps.map((step) => (
                <button className="safety-row" key={step.id} onClick={() => setSelectedStepId(step.id)}><Icon icon="warning-sign" intent="danger" size={14} /><span><strong>{step.title}</strong><small>危险项缺少控制措施或安全说明</small></span></button>
              )) : <p className="muted">所有存在危险项的步骤都已填写控制措施和安全说明。</p>}
            </Card>

            <Card elevation={Elevation.ONE} className="gate-card">
              <div className="card-title"><div><span>RELEASE GATE</span><h3>提交与冻结</h3></div></div>
              <div className="gate-row"><span>有效确认</span><strong>{derived.effectiveConfirmedCount}/{process.steps.length}</strong></div>
              <div className="gate-row"><span>安全缺口</span><strong className={derived.missingSafetySteps.length ? 'danger-text' : ''}>{derived.missingSafetySteps.length}</strong></div>
              <div className="gate-row"><span>合并冲突</span><strong className={conflictCount ? 'danger-text' : ''}>{conflictCount}</strong></div>
              <div className="gate-row"><span>流程状态</span><strong>{processStatusLabel(process.status)}</strong></div>
              <Divider />
              {process.status === 'frozen' ? <Button fill intent="warning" icon="git-branch" text="从冻结版创建修订" onClick={startRevision} /> : <Button fill intent="primary" icon="send-to" text="提交复核" onClick={submitForReview} />}
            </Card>
          </aside>
        </main>
      )}

      {activeView === 'review' && (
        <main className="review-layout">
          <aside className="review-steps">
            <div className="panel-heading"><div><span>REVIEW QUEUE</span><h3>逐条复核</h3></div><Tag intent={pendingBadge ? 'warning' : 'success'}>{pendingBadge ? `${pendingBadge} 待处理` : '已完成'}</Tag></div>
            {process.steps.map((step, index) => (
              <button key={step.id} className={`${step.id === selectedStep?.id ? 'selected' : ''} ${step.status}`} onClick={() => setSelectedStepId(step.id)}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <div><strong>{step.title}</strong><small>{statusLabel(step.status)}{derived.staleConfirmedStepIds.has(step.id) ? ' · 确认过期' : ''}</small></div>
                {derived.staleConfirmedStepIds.has(step.id)
                  ? <Icon icon="updated" intent="warning" size={15} />
                  : <Icon icon={step.status === 'confirmed' ? 'tick-circle' : step.status === 'returned' ? 'undo' : 'circle'} size={15} />}
              </button>
            ))}
          </aside>
          <section className="review-main">
            {selectedStep && (
              <>
                {derived.staleConfirmedStepIds.has(selectedStep.id) && (
                  <Callout intent="warning" icon="updated">上游步骤、依赖或危险项已变更，该步骤的确认已自动失效，请重新核对后再次确认。</Callout>
                )}
                <Card elevation={Elevation.ONE} className="review-summary">
                  <div className="card-title"><div><span>SAFETY REVIEW</span><h3>{selectedStep.title}</h3></div><Tag intent={selectedStep.status === 'confirmed' ? 'success' : selectedStep.status === 'returned' ? 'danger' : 'warning'}>{statusLabel(selectedStep.status)}</Tag></div>
                  <div className="review-facts">
                    <div><span>预计时间</span><strong>{selectedStep.duration} 分钟</strong></div>
                    <div><span>材料与用量</span><strong>{selectedStep.materials} / {selectedStep.amount}</strong></div>
                    <div><span>危险项</span><strong>{selectedStep.hazards.join('、') || '无'}</strong></div>
                  </div>
                  <div className="review-section"><h4>控制措施</h4><p>{selectedStep.controls || '未填写'}</p></div>
                  <div className="review-section"><h4>安全说明</h4><p className={hasMissingSafety(selectedStep) ? 'danger-text' : ''}>{selectedStep.safetyNote || '未填写'}</p></div>
                  {hasMissingSafety(selectedStep) && <Callout intent="danger" icon="warning-sign">当前步骤存在安全信息缺口，不能确认或冻结版本。</Callout>}
                </Card>
                <Card elevation={Elevation.ONE} className="comment-card">
                  <div className="card-title"><div><span>REVIEW COMMENTS</span><h3>复核批注</h3></div><Tag minimal>{selectedStep.comments.length} 条</Tag></div>
                  <div className="comment-compose">
                    <TextArea fill value={commentText} onChange={(event) => setCommentText(event.target.value)} placeholder="填写具体依据、风险或修改建议…" />
                    <Button intent="primary" icon="comment" text="添加批注" disabled={!commentText.trim()} onClick={addReviewComment} />
                  </div>
                  <div className="comment-list">
                    {selectedStep.comments.map((comment) => (
                      <article key={comment.id} className={comment.resolved ? 'resolved' : ''}>
                        <div className="comment-avatar">{comment.author.slice(0, 1)}</div>
                        <div><header><strong>{comment.author}</strong><span>{comment.role}</span><time>{formatDate(comment.createdAt)}</time></header><p>{comment.text}</p><Button minimal small text={comment.resolved ? '已解决' : '标记解决'} icon={comment.resolved ? 'tick' : 'circle'} onClick={() => {
                          const stepId = selectedStep.id;
                          commitProcess((draft) => {
                            const target = draft.steps.find((step) => step.id === stepId)?.comments.find((item) => item.id === comment.id);
                            if (target) target.resolved = !target.resolved;
                          });
                        }} /></div>
                      </article>
                    ))}
                    {!selectedStep.comments.length && <p className="muted">当前步骤尚未添加复核批注。</p>}
                  </div>
                </Card>
              </>
            )}
          </section>
          <aside className="review-actions">
            <Card elevation={Elevation.ONE}>
              <div className="card-title"><div><span>REVIEWER ACTION</span><h3>复核决定</h3></div><Icon icon="endorsed" size={18} /></div>
              <p className="muted">确认后若上游步骤、依赖或危险项再变化，该确认立即重算失效，与冻结检查同源。</p>
              <Button fill large intent="success" icon="tick" text="逐条确认" disabled={hasMissingSafety(selectedStep)} onClick={() => selectedStep && setStepStatus('confirmed')} />
              <Button fill large icon="undo" text="退回修改" intent="warning" onClick={() => selectedStep && setStepStatus('returned')} />
              <Button fill large minimal icon="refresh" text="恢复为待复核" onClick={() => selectedStep && setStepStatus('submitted')} />
              <Divider />
              <div className="review-progress-list">
                {process.steps.map((step) => <div key={step.id}><span>{step.title}</span><Tag minimal intent={derived.staleConfirmedStepIds.has(step.id) ? 'warning' : step.status === 'confirmed' ? 'success' : step.status === 'returned' ? 'danger' : 'warning'}>{derived.staleConfirmedStepIds.has(step.id) ? '过期' : statusLabel(step.status)}</Tag></div>)}
              </div>
              <Button fill intent="primary" icon="lock" text="全部确认后冻结" onClick={freezeVersion} disabled={!derived.canFreeze} />
            </Card>
          </aside>
        </main>
      )}

      {activeView === 'compare' && (
        <main className="compare-layout">
          <Card elevation={Elevation.ONE} className="version-panel">
            <div className="card-title"><div><span>VERSION TIMELINE</span><h3>冻结版本</h3></div><Tag minimal>{process.versions.length} 个</Tag></div>
            <div className="version-timeline">
              {process.versions.map((version, index) => (
                <article key={version.id} className={index === process.versions.length - 1 ? 'latest' : ''}>
                  <span></span><div><b>{version.version}</b><strong>{version.label}</strong><p>{formatDate(version.createdAt)} · {version.steps.length} 个步骤 · {version.author}</p><small>{version.note}</small></div>
                </article>
              ))}
            </div>
          </Card>
          <Card elevation={Elevation.ONE} className="diff-panel">
            <div className="card-title"><div><span>VERSION DIFF</span><h3>流程差异比较</h3></div><div className="diff-selects">
              <HTMLSelect value={compareBaseId} onChange={(event) => setCompareBaseId(event.target.value)}>{process.versions.map((version) => <option key={version.id} value={version.id}>{version.version} · 基准</option>)}</HTMLSelect>
              <Icon icon="arrow-right" />
              <HTMLSelect value={compareTargetId} onChange={(event) => setCompareTargetId(event.target.value)}>{process.versions.map((version) => <option key={version.id} value={version.id}>{version.version} · 目标</option>)}</HTMLSelect>
            </div></div>
            <div className="diff-table">
              <div className="diff-head"><span>变更类型</span><span>步骤</span><span>具体内容</span></div>
              {versionDiff.map((diff) => <div className={`diff-row ${diff.kind}`} key={diff.id}><Tag minimal intent={diff.kind === 'added' ? 'success' : diff.kind === 'removed' ? 'danger' : 'primary'}>{diff.kind === 'added' ? '新增' : diff.kind === 'removed' ? '删除' : '修改'}</Tag><strong>{diff.title}</strong><p>{diff.detail}</p></div>)}
              {!versionDiff.length && <div className="empty-diff"><Icon icon="comparison" size={30} /><strong>两个版本没有差异</strong><p>请选择不同版本，或先冻结新的流程版本。</p></div>}
            </div>
          </Card>
          <Card elevation={Elevation.ONE} className="freeze-rules">
            <div className="card-title"><div><span>FREEZE RULES</span><h3>冻结检查（统一结果）</h3></div></div>
            {derived.freezeChecks.map((check) => (
              <div key={check.label} className={check.passed ? 'passed' : ''}>
                <Icon icon={check.passed ? 'tick-circle' : 'circle'} />
                <span><strong>{check.label}</strong><small>{check.detail}</small></span>
              </div>
            ))}
            <Button fill intent="primary" icon="lock" text="冻结当前版本" onClick={freezeVersion} disabled={!derived.canFreeze} />
          </Card>
        </main>
      )}

      {activeView === 'merge' && (
        <MergeCenter
          process={process}
          peers={peers}
          pendingMerges={pendingMerges}
          failMode={failMode}
          lastMergeError={lastMergeError}
          onToggleFailMode={setFailMode}
          onMergePeer={handleMergePeer}
          onImportRemote={handleImportRemote}
          onExportRemote={handleExportRemote}
          onSeedDemo={handleSeedDemo}
          onResolve={handleResolve}
          onRetryPending={handleRetryPending}
          onDiscardPending={handleDiscardPending}
          onDismissReport={dismissReport}
        />
      )}

      <footer className="app-footer">
        <span>实验数据按页签分支保存在当前浏览器 localStorage，断网续写互不覆盖，可离线三路合并。</span>
        <span>Ctrl/Cmd + Z 撤销 · Ctrl/Cmd + Y 重做 · Ctrl/Cmd + S 保存</span>
      </footer>
    </div>
  );
}

export default App;
