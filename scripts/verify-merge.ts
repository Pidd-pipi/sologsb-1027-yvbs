// 临时验证脚本：离线三路合并引擎关键场景
import { mergeProcesses, resolveConflict, clearReportIfResolved } from '../src/lib/merge';
import { deriveReviewState, clone } from '../src/lib/derive';
import type { ExperimentProcess, ProcessStep, ReviewComment } from '../src/lib/types';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string): void {
  if (condition) { passed += 1; console.log(`  ✓ ${message}`); }
  else { failed += 1; console.error(`  ✗ ${message}`); }
}

function step(id: string, overrides: Partial<ProcessStep> = {}): ProcessStep {
  return {
    id, title: `步骤${id}`, purpose: '', materials: '', equipment: '', amount: '', duration: 10,
    hazards: [], controls: '', dependencies: [], safetyNote: '', expectedResult: '',
    status: 'confirmed', comments: [], contentUpdatedAt: '2026-01-01T00:00:00Z', ...overrides
  };
}

function makeProcess(steps: ProcessStep[], syncBase?: ExperimentProcess): ExperimentProcess {
  const p: ExperimentProcess = {
    id: 'exp-1', title: '实验', code: 'C-1', objective: '目标', principal: 'P', lab: 'L',
    status: 'in-review', version: '1.0-draft', steps, versions: [], updatedAt: '2026-01-01T00:00:00Z'
  };
  if (syncBase) {
    p.sync = { branchId: 'b-local', branchLabel: '本页', baseVersionId: 'v1', baseAt: '2026-01-01T00:00:00Z', base: clone(syncBase), mergedFrom: [] };
  }
  return p;
}

console.log('场景1：单边字段改动直接接上');
{
  const baseSteps = [step('s1'), step('s2', { dependencies: ['s1'] })];
  const base = makeProcess(baseSteps);
  const local = makeProcess(clone(baseSteps).map((s) => ({ ...s })), base);
  const remote = makeProcess(clone(baseSteps).map((s) => ({ ...s })), base);
  remote.sync!.branchId = 'b-remote'; remote.sync!.branchLabel = '对端';
  remote.steps[0].title = '对端改的标题';

  const { process: merged, report } = mergeProcesses(local, remote);
  assert(merged.steps[0].title === '对端改的标题', '对端单边改标题应自动接上');
  assert(report.conflicts.length === 0, '不应产生冲突');
}

console.log('场景2：同一步骤同一字段两边都改 → 保留两份冲突');
{
  const baseSteps = [step('s1', { controls: '基础控制' })];
  const base = makeProcess(baseSteps);
  const local = makeProcess(clone(baseSteps), base);
  const remote = makeProcess(clone(baseSteps), base);
  remote.sync!.branchId = 'b-remote';
  local.steps[0].controls = '本页的控制';
  remote.steps[0].controls = '对端的控制';

  const { process: merged, report } = mergeProcesses(local, remote);
  assert(report.conflicts.length === 1, `应有 1 条冲突，实际 ${report.conflicts.length}`);
  assert(report.conflicts[0].scope === 'step-field', '冲突类型是 step-field');
  assert(merged.steps[0].controls === '本页的控制', '暂存本页值');
  const adoptedRemote = resolveConflict(merged, report.conflicts[0].id, 'remote');
  assert(adoptedRemote.steps[0].controls === '对端的控制', '裁决采用对端');
  const keepBoth = resolveConflict(merged, report.conflicts[0].id, 'both');
  assert(keepBoth.steps[0].controls.includes('本页的控制') && keepBoth.steps[0].controls.includes('对端的控制'), '两份都保留');
}

console.log('场景3：同一条批注两边都改 → 批注冲突，两份可裁决');
{
  const comment: ReviewComment = { id: 'c1', author: 'A', role: '研究员', text: '原批注', createdAt: '2026-01-01T00:00:00Z', resolved: false };
  const baseSteps = [step('s1', { comments: [clone(comment)] })];
  const base = makeProcess(baseSteps);
  const local = makeProcess(clone(baseSteps), base);
  const remote = makeProcess(clone(baseSteps), base);
  remote.sync!.branchId = 'b-remote';
  local.steps[0].comments[0].text = '本页改批注';
  remote.steps[0].comments[0].text = '对端改批注';

  const { process: merged, report } = mergeProcesses(local, remote);
  assert(report.conflicts.length === 1 && report.conflicts[0].scope === 'comment', '产生批注冲突');
  const both = clearReportIfResolved(resolveConflict(merged, report.conflicts[0].id, 'both'));
  const texts = both.steps[0].comments.map((c) => c.text);
  assert(texts.some((t) => t.includes('本页改批注')) && texts.some((t) => t.includes('对端改批注')), '两份批注都保留');
  assert(!both.mergeReport, '冲突裁决完报告清空');
}

console.log('场景4：单边新增步骤 / 批注直接接上');
{
  const baseSteps = [step('s1')];
  const base = makeProcess(baseSteps);
  const local = makeProcess(clone(baseSteps), base);
  const remote = makeProcess(clone(baseSteps), base);
  remote.sync!.branchId = 'b-remote';
  remote.steps.push(step('s2-new', { title: '对端新增', dependencies: ['s1'] }));
  remote.steps[0].comments.push({ id: 'c-new', author: 'R', role: '复核员', text: '对端新批注', createdAt: '2026-02-01T00:00:00Z', resolved: false });

  const { process: merged, report } = mergeProcesses(local, remote);
  assert(merged.steps.some((s) => s.title === '对端新增'), '对端新增步骤接上');
  assert(merged.steps[0].comments.some((c) => c.text === '对端新批注'), '对端新增批注接上');
  assert(report.conflicts.length === 0, '无冲突');
}

console.log('场景5：步骤、依赖、危险项变化 → 下游已确认立即重算为过期');
{
  const baseSteps = [
    step('s1', { status: 'confirmed', contentUpdatedAt: '2026-01-01T00:00:00Z', confirmedAt: '2026-01-02T00:00:00Z' }),
    step('s2', { status: 'confirmed', dependencies: ['s1'], contentUpdatedAt: '2026-01-01T00:00:00Z', confirmedAt: '2026-01-02T00:00:00Z' })
  ];
  const base = makeProcess(baseSteps);
  const local = makeProcess(clone(baseSteps), base);
  const remote = makeProcess(clone(baseSteps), base);
  remote.sync!.branchId = 'b-remote';
  // 对端修改上游 s1
  remote.steps[0].controls = '新控制措施';
  remote.steps[0].contentUpdatedAt = '2026-03-01T00:00:00Z';

  const { process: merged } = mergeProcesses(local, remote);
  const derived = deriveReviewState(merged);
  assert(derived.staleConfirmedStepIds.has('s2'), '下游 s2 确认过期');
  assert(!derived.canFreeze, '有过期确认时不能冻结');

  // 编辑器场景：本地直接改步骤字段
  const edited = clone(local);
  edited.steps[0].hazards = ['新危险'];
  edited.steps[0].contentUpdatedAt = '2026-03-02T00:00:00Z';
  const derived2 = deriveReviewState(edited);
  assert(derived2.staleConfirmedStepIds.has('s2'), '编辑后下游确认同样过期');
}

console.log('场景6：基线分叉 — 对端基于不同冻结版，保留双分支且不从旧快照重写底稿');
{
  const v1Steps = [step('s1', { title: 'V1标题' })];
  const v2Steps = [step('s1', { title: 'V2标题', controls: 'V2控制' })];
  const makeVersioned = (): ExperimentProcess => {
    const p = makeProcess(clone(v2Steps));
    p.versions = [
      { id: 'v1', label: 'v1', version: '1.0.0', createdAt: '2026-01-01T00:00:00Z', note: '', author: 'A', steps: clone(v1Steps) },
      { id: 'v2', label: 'v2', version: '1.1.0', createdAt: '2026-02-01T00:00:00Z', note: '', author: 'A', steps: clone(v2Steps) }
    ];
    return p;
  };
  const local = makeVersioned();
  local.sync = { branchId: 'b-local', branchLabel: '本页', baseVersionId: 'v2', baseAt: '2026-02-01T00:00:00Z', base: clone(local), mergedFrom: [] };
  const remote = makeVersioned();
  remote.sync = { branchId: 'b-remote', branchLabel: '对端', baseVersionId: 'v1', baseAt: '2026-01-01T00:00:00Z', base: clone(remote), mergedFrom: [] };
  remote.steps[0].title = 'V1基线上的对端修改';

  const { process: merged, report } = mergeProcesses(local, remote);
  assert(report.baseDiverged, '识别为基线分叉');
  assert(report.conflicts.some((c) => c.scope === 'base-diverged'), '保留基线分叉冲突');
  assert(merged.versions.some((v) => v.id === 'v1') && merged.versions.some((v) => v.id === 'v2'), '两条冻结分支版本都保留');
  assert(merged.steps[0].title !== 'V1标题', '没有用旧快照重写底稿');
}

console.log('场景7：危险项/依赖集合双方增删自动取并集，清理悬空依赖');
{
  const baseSteps = [step('s1', { hazards: ['A', 'B'], dependencies: [] }), step('s2', { hazards: [], dependencies: ['s1'] })];
  const base = makeProcess(baseSteps);
  const local = makeProcess(clone(baseSteps), base);
  const remote = makeProcess(clone(baseSteps), base);
  remote.sync!.branchId = 'b-remote';
  local.steps[0].hazards = ['A', 'C'];
  remote.steps[0].hazards = ['B', 'D'];
  // 对端删除 s1，本页保留（未改 s1）→ 单边删除应接上，s2 悬空依赖被清理
  remote.steps = remote.steps.filter((s) => s.id !== 's1');

  const { process: merged } = mergeProcesses(local, remote);
  // 本页修改了 s1（hazards 从 [A,B] → [A,C]）→ 与对端删除冲突，s1 保留待裁决；悬空依赖无
  assert(merged.steps.some((s) => s.id === 's1'), '本页改过 s1，对端删除 → s1 保留待裁决');
  assert(merged.mergeReport!.conflicts.some((c) => c.scope === 'step-life'), '步骤删改冲突');

  // 纯依赖场景
  const base2 = makeProcess(baseSteps);
  const local2 = makeProcess(clone(baseSteps), base2);
  const remote2 = makeProcess(clone(baseSteps), base2);
  remote2.sync!.branchId = 'b-remote';
  local2.steps[0].hazards = ['A', 'C'];
  remote2.steps[0].hazards = ['B', 'D'];
  const merged2 = mergeProcesses(local2, remote2).process;
  assert(JSON.stringify(merged2.steps[0].hazards.sort()) === JSON.stringify(['A', 'B', 'C', 'D']), '危险项并集 A/B/C/D');
}

console.log('场景8：处理失败保留原草稿');
{
  const baseSteps = [step('s1')];
  const base = makeProcess(baseSteps);
  const local = makeProcess(clone(baseSteps), base);
  const remote = makeProcess(clone(baseSteps), base);
  remote.steps[0].title = '对端';
  let errorCaught = false;
  try {
    mergeProcesses(local, remote, { simulateFailure: true });
  } catch {
    errorCaught = true;
  }
  assert(errorCaught, '模拟失败抛错');
  assert(local.steps[0].title === '步骤s1', '原草稿完全未改动，可重试');
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
