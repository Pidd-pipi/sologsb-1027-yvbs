import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  Button,
  Callout,
  Card,
  Checkbox,
  Dialog,
  DialogBody,
  DialogFooter,
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
  ExperimentProcess,
  MergeConflict,
  ProcessStep,
  RevisionBranch,
  StepStatus
} from './types';
import {
  STORAGE_KEY,
  applyConflictResolution,
  clone,
  diffSteps,
  loadInitialRecord,
  makeBranch,
  normalizeProcess,
  processStatusLabel,
  renderConflictValue,
  stepDigest,
  synchronize,
  uid,
  unionVersions,
  upsertBranch
} from './sync';
import type { SyncState } from './sync';

type ViewId = 'editor' | 'review' | 'compare';

interface HistoryState {
  past: ExperimentProcess[];
  present: ExperimentProcess;
  future: ExperimentProcess[];
}

const CURRENT_AUTHOR = '周宁';
const CURRENT_ROLE = '安全复核员';
const TAB_ID = uid('tab');

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
    if (step.status === 'confirmed') step.confirmedDigest = stepDigest(step);
  });

  const firstVersion = {
    id: 'version-1-0', label: '首版批准流程', version: '1.0.0', createdAt: '2026-09-20T14:30:00+08:00',
    note: '建立基础反应与取样步骤。', author: '王颖',
    steps: clone(baseSteps).slice(0, 4).map((step) => ({ ...step, status: 'confirmed' as const, comments: [] }))
  };
  const secondVersion = {
    id: 'version-1-1', label: '补充冷却与废液步骤', version: '1.1.0', createdAt: '2026-09-24T15:10:00+08:00',
    note: '增加安全冷却、废液处置和现场恢复。', author: '王颖',
    steps: clone(baseSteps).map((step) => ({ ...step, status: 'confirmed' as const, comments: [] }))
  };

  return {
    id: 'exp-catalyst-2026-09', title: '负载型催化剂评价实验', code: 'SAFE-CAT-026',
    objective: '在受控温度下评价催化剂活性，并完整记录过程样品与安全控制措施。',
    principal: '李明', lab: '材料化学实验室 B-207',
    status: 'in-review', version: '1.2.0-draft',
    steps: baseSteps, versions: [firstVersion, secondVersion], updatedAt: new Date().toISOString(),
    draftId: 'draft-initial', baseVersionId: 'version-1-1',
    branches: [], conflicts: [], resolvedConflicts: []
  };
}

type HistoryAction =
  | { type: 'commit'; update: (draft: ExperimentProcess) => void }
  | { type: 'replace'; value: ExperimentProcess }
  | { type: 'undo' }
  | { type: 'redo' };

function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  if (action.type === 'commit') {
    const draft = clone(state.present);
    action.update(draft);
    draft.updatedAt = new Date().toISOString();
    // 每次提交后立即重算确认状态，冻结检查读取同一份结果
    const next = normalizeProcess(draft);
    return { past: [...state.past.slice(-59), clone(state.present)], present: next, future: [] };
  }
  if (action.type === 'replace') {
    const next = normalizeProcess(clone(action.value));
    if (JSON.stringify(next) === JSON.stringify(state.present)) return state;
    return { past: [...state.past.slice(-59), clone(state.present)], present: next, future: [] };
  }
  if (action.type === 'undo') {
    const previous = state.past.at(-1);
    if (!previous) return state;
    return { past: state.past.slice(0, -1), present: previous, future: [clone(state.present), ...state.future].slice(0, 60) };
  }
  const next = state.future[0];
  if (!next) return state;
  return { past: [...state.past, clone(state.present)].slice(-60), present: next, future: state.future.slice(1) };
}

function splitList(value: string): string[] {
  return value.split(/[\n,，、;；]+/).map((item) => item.trim()).filter(Boolean);
}

function statusLabel(status: StepStatus): string {
  return status === 'confirmed' ? '已确认' : status === 'returned' ? '已退回' : status === 'submitted' ? '待复核' : '草稿';
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date);
}

function App() {
  const [initialRecord] = useState(() => loadInitialRecord());
  const [history, dispatch] = useReducer(historyReducer, initialRecord, (record) => ({
    past: [],
    present: record?.process ?? normalizeProcess(initialProcess()),
    future: []
  }));
  const process = history.present;
  const [selectedStepId, setSelectedStepId] = useState(process.steps[0]?.id ?? '');
  const [activeView, setActiveView] = useState<ViewId>('editor');
  const [lastModifiedId, setLastModifiedId] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [savedLabel, setSavedLabel] = useState('本地数据已载入');
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [conflictDialogOpen, setConflictDialogOpen] = useState(false);
  const [online, setOnline] = useState(true);
  const [compareBaseId, setCompareBaseId] = useState(process.versions.at(-1)?.id ?? 'current');
  const [compareTargetId, setCompareTargetId] = useState('current');
  const syncRef = useRef<SyncState>({
    lastSeen: initialRecord?.revision ?? null,
    base: initialRecord?.process ?? null
  });
  const processRef = useRef(process);
  processRef.current = process;

  const selectedStep = process.steps.find((step) => step.id === selectedStepId) ?? process.steps[0];
  const downstreamIds = useMemo(() => collectDownstream(process.steps, lastModifiedId), [process.steps, lastModifiedId]);
  const impactedSteps = process.steps.filter((step) => downstreamIds.includes(step.id));
  const missingSafetySteps = process.steps.filter(hasMissingSafety);
  const staleConfirmations = process.steps.filter((step) => step.confirmationStale);
  const pendingReviewCount = process.steps.filter((step) => step.status === 'submitted' || step.status === 'returned').length;
  const confirmedCount = process.steps.filter((step) => step.status === 'confirmed').length;
  const reviewProgress = process.steps.length ? Math.round((confirmedCount / process.steps.length) * 100) : 0;
  const visibleBranches = useMemo(
    () => process.branches.filter((branch) => branch.id !== process.draftId),
    [process.branches, process.draftId]
  );
  const compareSources = useMemo(() => {
    const sources = process.versions.map((version) => ({
      id: version.id,
      label: `${version.version} · ${version.label}`,
      steps: version.steps
    }));
    sources.push({ id: 'current', label: `当前草稿 · ${process.version}`, steps: process.steps });
    visibleBranches.forEach((branch) => {
      sources.push({ id: `branch:${branch.id}`, label: `分支 · ${branch.version} · ${branch.savedBy}`, steps: branch.process.steps });
    });
    return sources;
  }, [process.versions, process.steps, process.version, visibleBranches]);
  const versionDiff = useMemo(() => {
    const base = compareSources.find((source) => source.id === compareBaseId) ?? compareSources[0];
    const target = compareSources.find((source) => source.id === compareTargetId) ?? compareSources[0];
    return diffSteps(base.steps, target.steps);
  }, [compareSources, compareBaseId, compareTargetId]);

  const versionLabel = (versionId: string): string =>
    process.versions.find((version) => version.id === versionId)?.version ?? '—';
  const branchBaseLabel = (branch: RevisionBranch): string =>
    process.versions.find((version) => version.id === branch.baseVersionId)?.version ??
    branch.process.versions.find((version) => version.id === branch.baseVersionId)?.version ??
    '—';

  /* 离线合并：保存时检测另一页签的修改，三方合并或保留修订分支 */
  const runSync = useCallback((current: ExperimentProcess): void => {
    try {
      const outcome = synchronize(current, syncRef.current, {
        savedBy: CURRENT_AUTHOR,
        tabId: TAB_ID,
        formatTime: formatDate
      });
      syncRef.current = outcome.state;
      if (outcome.replace) dispatch({ type: 'replace', value: outcome.replace });
      if (outcome.branches) {
        const branches = outcome.branches;
        dispatch({ type: 'commit', update: (draft) => { draft.branches = clone(branches); } });
      }
      if (outcome.kind === 'saved' && outcome.savedAt) {
        setSavedLabel(`自动保存 · ${formatDate(outcome.savedAt)}`);
      } else if (outcome.kind === 'merged' && outcome.mergeStats) {
        const stats = outcome.mergeStats;
        setSyncNotice(
          stats.conflicts > 0
            ? `已合并另一页签的修改：${stats.auto} 处自动接上，${stats.conflicts} 处两边都改过，两份都已保留待你决定。`
            : `已自动合并另一页签的 ${stats.auto} 处修改，无需人工处理。`
        );
        if (outcome.savedAt) setSavedLabel(`合并保存 · ${formatDate(outcome.savedAt)}`);
      } else if (outcome.kind === 'branched') {
        setSyncNotice('另一侧基于不同的冻结版本，本页草稿已保留为独立修订分支，两条分支都不会被覆盖。');
        if (outcome.savedAt) setSavedLabel(`分支已保存 · ${formatDate(outcome.savedAt)}`);
      }
      setSyncError(null);
    } catch (error) {
      // 处理失败：原草稿留在内存中不动，可重试
      setSyncError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    runSync(process);
  }, [process, runSync]);

  useEffect(() => {
    const handler = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || event.newValue === null) return;
      runSync(processRef.current);
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, [runSync]);

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
        runSync(process);
        setSavedLabel(`手动保存 · ${formatDate(new Date().toISOString())}`);
      }
    };
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, [process, runSync]);

  const commitProcess = (update: (draft: ExperimentProcess) => void): void => {
    dispatch({ type: 'commit', update });
  };

  const updateProcessField = (field: 'title' | 'code' | 'objective' | 'principal' | 'lab', value: string): void => {
    commitProcess((draft) => { draft[field] = value; });
  };

  const updateStep = (field: keyof ProcessStep, value: unknown): void => {
    if (!selectedStep) return;
    const id = selectedStep.id;
    setLastModifiedId(id);
    commitProcess((draft) => {
      const step = draft.steps.find((item) => item.id === id);
      if (step) (step as unknown as Record<string, unknown>)[field] = value;
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
        safetyNote: '', expectedResult: '', status: 'draft', comments: []
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
    copy.confirmedDigest = undefined;
    copy.confirmationStale = undefined;
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
      });
    });
    setCommentText('');
  };

  const setStepStatus = (status: StepStatus): void => {
    if (!selectedStep) return;
    const id = selectedStep.id;
    setLastModifiedId(status === 'returned' ? id : null);
    commitProcess((draft) => {
      const step = draft.steps.find((item) => item.id === id);
      if (!step) return;
      step.status = status;
      if (status === 'confirmed') {
        step.confirmedDigest = stepDigest(step);
        step.confirmationStale = false;
      }
    });
  };

  const resolveComment = (commentId: string): void => {
    if (!selectedStep) return;
    const stepId = selectedStep.id;
    commitProcess((draft) => {
      const comment = draft.steps.find((step) => step.id === stepId)?.comments.find((item) => item.id === commentId);
      if (comment) comment.resolved = !comment.resolved;
    });
  };

  const freezeVersion = (): void => {
    if (process.status === 'frozen') return;
    if (process.steps.some((step) => step.status !== 'confirmed') || missingSafetySteps.length) {
      setSavedLabel('冻结条件未满足');
      return;
    }
    const nextNumber = nextMinorVersion(process.version);
    const previousVersionId = process.versions.at(-1)?.id ?? '';
    const frozenVersionId = uid('version');
    commitProcess((draft) => {
      draft.versions.push({
        id: frozenVersionId, label: '复核通过冻结版', version: nextNumber,
        createdAt: new Date().toISOString(), note: `${draft.steps.length} 个步骤全部确认，安全控制完整。`,
        author: CURRENT_AUTHOR, steps: clone(draft.steps)
      });
      draft.version = nextNumber;
      draft.status = 'frozen';
      draft.frozenAt = new Date().toISOString();
      draft.baseVersionId = frozenVersionId;
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
      draft.draftId = uid('draft');
      draft.baseVersionId = draft.versions.at(-1)?.id ?? draft.baseVersionId;
      draft.steps.forEach((step) => {
        step.status = 'draft';
        step.comments = [];
        step.confirmedDigest = undefined;
        step.confirmationStale = undefined;
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

  const resolveConflict = (conflict: MergeConflict, side: 'shared' | 'local'): void => {
    commitProcess((draft) => {
      applyConflictResolution(draft, conflict, side);
    });
  };

  const adoptBranch = (branch: RevisionBranch): void => {
    const currentAsBranch = makeBranch(process, CURRENT_AUTHOR);
    const adopted = clone(branch.process);
    adopted.branches = upsertBranch(
      process.branches.filter((item) => item.id !== branch.id && item.id !== adopted.draftId),
      currentAsBranch
    );
    adopted.versions = unionVersions(adopted.versions, process.versions);
    dispatch({ type: 'replace', value: adopted });
    setActiveView('editor');
    setSavedLabel(`已切换到分支 ${branch.version}，原草稿已保留为修订分支`);
  };

  const removeBranch = (branchId: string): void => {
    commitProcess((draft) => {
      draft.branches = draft.branches.filter((item) => item.id !== branchId);
    });
  };

  const compareWithBranch = (branch: RevisionBranch): void => {
    setCompareBaseId(`branch:${branch.id}`);
    setCompareTargetId('current');
    setActiveView('compare');
  };

  const selectedUpstreamUnconfirmed = selectedStep
    ? selectedStep.dependencies.some((id) => process.steps.find((step) => step.id === id)?.status !== 'confirmed')
    : false;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-block">
          <div className="brand-icon"><Icon icon="lab-test" size={23} /></div>
          <div><h1>实验流程安全复核台</h1><p>步骤影响分析 · 逐条复核 · 冻结版本 · 离线合并</p></div>
        </div>
        <div className="header-status">
          <span className={`network ${online ? 'online' : ''}`}></span>
          <span>{online ? '离线保存已启用' : '当前离线，修改仍会保存'}</span>
          <strong>{savedLabel}</strong>
        </div>
        <div className="header-actions">
          <Button icon="undo" text="撤销" minimal disabled={history.past.length === 0} onClick={() => dispatch({ type: 'undo' })} />
          <Button icon="redo" text="重做" minimal disabled={history.future.length === 0} onClick={() => dispatch({ type: 'redo' })} />
          <Button icon="floppy-disk" text="保存快照" onClick={addVersionSnapshot} />
          <Button icon="lock" text="冻结版本" intent="primary" onClick={freezeVersion} disabled={process.status === 'frozen'} />
        </div>
      </header>

      {!online && <Callout className="offline-callout" intent="warning" icon="cloud">网络不可用。编辑、复核和版本快照仍会保存在当前浏览器。</Callout>}

      {syncError && (
        <Callout className="sync-callout" intent="danger" icon="error">
          <div className="callout-line">
            <span>离线合并处理失败：{syncError}。当前草稿保持原样未受影响，可以重试。</span>
            <Button small intent="danger" icon="refresh" text="重试" onClick={() => runSync(process)} />
          </div>
        </Callout>
      )}
      {syncNotice && !syncError && (
        <Callout className="sync-callout" intent="primary" icon="git-merge">
          <div className="callout-line">
            <span>{syncNotice}</span>
            <Button small minimal icon="cross" onClick={() => setSyncNotice(null)} />
          </div>
        </Callout>
      )}
      {process.conflicts.length > 0 && (
        <Callout className="sync-callout" intent="warning" icon="warning-sign">
          <div className="callout-line">
            <span>检测到 {process.conflicts.length} 处两个页签都改过的内容，两份修改都已保留，请逐项决定采用哪一份。</span>
            <Button small intent="warning" icon="resolve" text="处理冲突" onClick={() => setConflictDialogOpen(true)} />
          </div>
        </Callout>
      )}
      {visibleBranches.length > 0 && (
        <Callout className="sync-callout" intent="primary" icon="git-branch">
          <div className="callout-line">
            <span>存在 {visibleBranches.length} 条基于其他冻结版本的修订分支，两条分支均已保留，不会互相覆盖。</span>
            <Button small icon="comparison" text="查看分支" onClick={() => setActiveView('compare')} />
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
          <div><span>基于冻结版</span><strong>{versionLabel(process.baseVersionId)}</strong></div>
        </div>
        <div className="banner-progress">
          <div><span>复核进度</span><strong>{confirmedCount}/{process.steps.length}</strong></div>
          <ProgressBar value={reviewProgress / 100} intent={reviewProgress === 100 ? 'success' : 'primary'} stripes={reviewProgress < 100} />
          <small>{pendingReviewCount ? `${pendingReviewCount} 条待处理` : '所有步骤已处理'} · {missingSafetySteps.length} 条安全缺口{staleConfirmations.length ? ` · ${staleConfirmations.length} 条确认待重核` : ''}</small>
        </div>
      </section>

      <Tabs id="workspace-tabs" selectedTabId={activeView} onChange={(value) => setActiveView(value as ViewId)} renderActiveTabPanelOnly className="workspace-tabs">
        <Tab id="editor" title={<span><Icon icon="edit" /> 流程编写</span>} />
        <Tab id="review" title={<span><Icon icon="endorsed" /> 安全复核 {pendingReviewCount > 0 && <b className="tab-badge">{pendingReviewCount}</b>}</span>} />
        <Tab id="compare" title={<span><Icon icon="comparison" /> 版本比较</span>} />
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
                  <span className="step-copy"><strong>{step.title}</strong><small>{step.duration} 分钟 · {statusLabel(step.status)}</small></span>
                  {hasMissingSafety(step) && <Icon icon="warning-sign" intent="danger" size={13} />}
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
                <Tag minimal intent={selectedStep.status === 'confirmed' ? 'success' : selectedStep.status === 'returned' ? 'danger' : 'warning'}>{statusLabel(selectedStep.status)}</Tag>
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
              <p className="muted">当前步骤只有在所选前置步骤完成后才能进入执行队列。</p>
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
                    <p>{impactedSteps.length ? '请重新核对依赖、用量、危险项和已确认内容。' : '当前修改没有影响其他步骤的安全条件。'}</p>
                  </Callout>
                  <div className="impact-list">
                    {impactedSteps.map((step) => (
                      <button key={step.id} onClick={() => setSelectedStepId(step.id)}>
                        <Icon icon={step.status === 'confirmed' ? 'endorsed' : 'circle'} intent={step.status === 'confirmed' ? 'success' : 'none'} size={13} />
                        <span><strong>{step.title}</strong><small>{step.status === 'confirmed' ? '已确认内容，需重新复核' : `当前状态：${statusLabel(step.status)}`}</small></span>
                        <Icon icon="chevron-right" size={12} />
                      </button>
                    ))}
                  </div>
                </>
              ) : <p className="muted">编辑任一步骤后，这里会显示受影响的所有后续步骤和已确认内容。</p>}
            </Card>

            <Card elevation={Elevation.ONE} className="safety-card">
              <div className="card-title"><div><span>SAFETY GATE</span><h3>安全完整性</h3></div><Tag intent={missingSafetySteps.length ? 'danger' : 'success'} minimal>{missingSafetySteps.length ? `${missingSafetySteps.length} 项缺口` : '通过'}</Tag></div>
              {missingSafetySteps.length ? missingSafetySteps.map((step) => (
                <button className="safety-row" key={step.id} onClick={() => setSelectedStepId(step.id)}><Icon icon="warning-sign" intent="danger" size={14} /><span><strong>{step.title}</strong><small>危险项缺少控制措施或安全说明</small></span></button>
              )) : <p className="muted">所有存在危险项的步骤都已填写控制措施和安全说明。</p>}
              {staleConfirmations.length > 0 && (
                <div className="stale-note">
                  <Icon icon="history" intent="warning" size={14} />
                  <span><strong>{staleConfirmations.length} 条确认已重算置回</strong><small>步骤、依赖或危险项变化后，下游确认需重新复核</small></span>
                </div>
              )}
            </Card>

            <Card elevation={Elevation.ONE} className="gate-card">
              <div className="card-title"><div><span>RELEASE GATE</span><h3>提交与冻结</h3></div></div>
              <div className="gate-row"><span>复核状态</span><strong>{confirmedCount}/{process.steps.length}</strong></div>
              <div className="gate-row"><span>安全缺口</span><strong className={missingSafetySteps.length ? 'danger-text' : ''}>{missingSafetySteps.length}</strong></div>
              <div className="gate-row"><span>确认重算置回</span><strong className={staleConfirmations.length ? 'danger-text' : ''}>{staleConfirmations.length}</strong></div>
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
            <div className="panel-heading"><div><span>REVIEW QUEUE</span><h3>逐条复核</h3></div><Tag intent={pendingReviewCount ? 'warning' : 'success'}>{pendingReviewCount ? `${pendingReviewCount} 待处理` : '已完成'}</Tag></div>
            {process.steps.map((step, index) => (
              <button key={step.id} className={`${step.id === selectedStep?.id ? 'selected' : ''} ${step.status}`} onClick={() => setSelectedStepId(step.id)}>
                <span>{String(index + 1).padStart(2, '0')}</span><div><strong>{step.title}</strong><small>{statusLabel(step.status)}</small></div><Icon icon={step.status === 'confirmed' ? 'tick-circle' : step.status === 'returned' ? 'undo' : 'circle'} size={15} />
              </button>
            ))}
          </aside>
          <section className="review-main">
            {selectedStep && (
              <>
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
                        <div><header><strong>{comment.author}</strong><span>{comment.role}</span><time>{formatDate(comment.createdAt)}</time></header><p>{comment.text}</p><Button minimal small text={comment.resolved ? '已解决' : '标记解决'} icon={comment.resolved ? 'tick' : 'circle'} onClick={() => resolveComment(comment.id)} /></div>
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
              <p className="muted">确认后若修改该步骤，受影响的下游步骤会在编辑页重新提示。</p>
              <Button fill large intent="success" icon="tick" text="逐条确认" disabled={hasMissingSafety(selectedStep) || selectedUpstreamUnconfirmed} onClick={() => setStepStatus('confirmed')} />
              {selectedUpstreamUnconfirmed && <p className="muted">前置步骤尚未全部确认，需先确认上游步骤。</p>}
              <Button fill large icon="undo" text="退回修改" intent="warning" onClick={() => setStepStatus('returned')} />
              <Button fill large minimal icon="refresh" text="恢复为待复核" onClick={() => setStepStatus('submitted')} />
              <Divider />
              <div className="review-progress-list">
                {process.steps.map((step) => <div key={step.id}><span>{step.title}</span><Tag minimal intent={step.status === 'confirmed' ? 'success' : step.status === 'returned' ? 'danger' : 'warning'}>{statusLabel(step.status)}</Tag></div>)}
              </div>
              <Button fill intent="primary" icon="lock" text="全部确认后冻结" onClick={freezeVersion} disabled={process.status === 'frozen'} />
            </Card>
          </aside>
        </main>
      )}

      {activeView === 'compare' && (
        <main className="compare-layout">
          <div className="compare-side">
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
            <Card elevation={Elevation.ONE} className="branch-panel">
              <div className="card-title"><div><span>REVISION BRANCHES</span><h3>修订分支</h3></div><Tag minimal>{visibleBranches.length} 条</Tag></div>
              {visibleBranches.length ? visibleBranches.map((branch) => (
                <article className="branch-item" key={branch.id}>
                  <header><b>{branch.version}</b><Tag minimal intent="primary">{processStatusLabel(branch.process.status)}</Tag></header>
                  <p>基于冻结版 {branchBaseLabel(branch)} · {branch.savedBy} · {formatDate(branch.savedAt)}</p>
                  <p>{branch.process.steps.length} 个步骤{branch.process.conflicts.length ? ` · ${branch.process.conflicts.length} 处待处理冲突` : ''}</p>
                  <div className="branch-actions">
                    <Button small minimal icon="comparison" text="比较" onClick={() => compareWithBranch(branch)} />
                    <Button small minimal intent="primary" icon="git-branch" text="采纳" onClick={() => adoptBranch(branch)} />
                    <Button small minimal intent="danger" icon="trash" onClick={() => removeBranch(branch.id)} />
                  </div>
                </article>
              )) : <p className="muted">所有页签都基于同一冻结版本，没有分叉的修订分支。</p>}
            </Card>
          </div>
          <Card elevation={Elevation.ONE} className="diff-panel">
            <div className="card-title"><div><span>VERSION DIFF</span><h3>流程差异比较</h3></div><div className="diff-selects">
              <HTMLSelect value={compareBaseId} onChange={(event) => setCompareBaseId(event.target.value)}>{compareSources.map((source) => <option key={source.id} value={source.id}>{source.label}</option>)}</HTMLSelect>
              <Icon icon="arrow-right" />
              <HTMLSelect value={compareTargetId} onChange={(event) => setCompareTargetId(event.target.value)}>{compareSources.map((source) => <option key={source.id} value={source.id}>{source.label}</option>)}</HTMLSelect>
            </div></div>
            <div className="diff-table">
              <div className="diff-head"><span>变更类型</span><span>步骤</span><span>具体内容</span></div>
              {versionDiff.map((diff) => <div className={`diff-row ${diff.kind}`} key={diff.id}><Tag minimal intent={diff.kind === 'added' ? 'success' : diff.kind === 'removed' ? 'danger' : 'primary'}>{diff.kind === 'added' ? '新增' : diff.kind === 'removed' ? '删除' : '修改'}</Tag><strong>{diff.title}</strong><p>{diff.detail}</p></div>)}
              {!versionDiff.length && <div className="empty-diff"><Icon icon="comparison" size={30} /><strong>两个版本没有差异</strong><p>请选择不同版本，或先冻结新的流程版本。</p></div>}
            </div>
          </Card>
          <Card elevation={Elevation.ONE} className="freeze-rules">
            <div className="card-title"><div><span>FREEZE RULES</span><h3>冻结检查</h3></div></div>
            <div className={confirmedCount === process.steps.length ? 'passed' : ''}><Icon icon={confirmedCount === process.steps.length ? 'tick-circle' : 'circle'} /><span><strong>所有步骤已确认</strong><small>{confirmedCount}/{process.steps.length}</small></span></div>
            <div className={!missingSafetySteps.length ? 'passed' : ''}><Icon icon={!missingSafetySteps.length ? 'tick-circle' : 'circle'} /><span><strong>安全信息完整</strong><small>{missingSafetySteps.length} 个缺口</small></span></div>
            <div className={!staleConfirmations.length ? 'passed' : ''}><Icon icon={!staleConfirmations.length ? 'tick-circle' : 'history'} /><span><strong>确认状态已重算</strong><small>{staleConfirmations.length} 条待重新确认</small></span></div>
            <div className={process.steps.every((step) => step.dependencies.every((id) => process.steps.some((item) => item.id === id))) ? 'passed' : ''}><Icon icon="git-merge" /><span><strong>依赖引用有效</strong><small>{process.steps.reduce((sum, step) => sum + step.dependencies.length, 0)} 条依赖</small></span></div>
            <Button fill intent="primary" icon="lock" text="冻结当前版本" onClick={freezeVersion} disabled={process.status === 'frozen' || confirmedCount !== process.steps.length || missingSafetySteps.length > 0} />
          </Card>
        </main>
      )}

      <Dialog
        isOpen={conflictDialogOpen}
        onClose={() => setConflictDialogOpen(false)}
        title={`离线合并冲突（${process.conflicts.length}）`}
        icon="git-merge"
        className="conflict-dialog"
      >
        <DialogBody>
          <p className="muted">同一处内容在两个页签中分别被修改，两份修改都已保留。请为每一处选择采用哪一份，处理后另一页签会同步结果。</p>
          {process.conflicts.map((conflict) => (
            <section className="conflict-item" key={conflict.id}>
              <h4>{conflict.title}</h4>
              <div className="conflict-options">
                <div className="conflict-option">
                  <header><Tag intent="primary" minimal>共享底稿</Tag><small>{conflict.sharedLabel}</small></header>
                  <p>{renderConflictValue(conflict.sharedValue)}</p>
                  <div><Button small intent="primary" text="采用这份" onClick={() => resolveConflict(conflict, 'shared')} /></div>
                </div>
                <div className="conflict-option">
                  <header><Tag intent="warning" minimal>另一版本</Tag><small>{conflict.localLabel}</small></header>
                  <p>{renderConflictValue(conflict.localValue)}</p>
                  <div><Button small intent="warning" text="采用这份" onClick={() => resolveConflict(conflict, 'local')} /></div>
                </div>
              </div>
            </section>
          ))}
          {!process.conflicts.length && <p className="muted">所有冲突都已处理，可以关闭此窗口。</p>}
        </DialogBody>
        <DialogFooter actions={<Button text="关闭" onClick={() => setConflictDialogOpen(false)} />} />
      </Dialog>

      <footer className="app-footer">
        <span>所有实验数据仅保存在当前浏览器 localStorage，多个页签的修改会自动离线合并。</span>
        <span>Ctrl/Cmd + Z 撤销 · Ctrl/Cmd + Y 重做 · Ctrl/Cmd + S 保存</span>
      </footer>
    </div>
  );
}

function hasMissingSafety(step: ProcessStep): boolean {
  return step.hazards.length > 0 && (!step.controls.trim() || !step.safetyNote.trim());
}

function collectDownstream(steps: ProcessStep[], sourceId: string | null): string[] {
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

function nextMinorVersion(value: string): string {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return '1.2.0';
  return `${match[1]}.${Number(match[2]) + 1}.0`;
}

export default App;
