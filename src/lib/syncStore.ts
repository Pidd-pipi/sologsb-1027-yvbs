import { clone } from './derive';
import type { ExperimentProcess, PendingMerge, PeerDraft } from './types';

/**
 * 多页签离线存储：
 * - 每个页签是一条修订分支，草稿分键存储，避免“后保存覆盖先保存”；
 * - 页签打开时登记心跳，其它页签通过 storage 事件发现对端草稿；
 * - 首次从旧的单键草稿迁移；找不到共同祖先或处理失败都不改动本页草稿。
 */
export const LEGACY_KEY = 'sologsb-1027-lab-safety-v1';
const REGISTRY_KEY = 'sologsb-1027-branches-v1';
const DRAFT_PREFIX = 'sologsb-1027-draft-';
const PENDING_PREFIX = 'sologsb-1027-pending-merge-';
const SESSION_BRANCH_KEY = 'sologsb-1027-branch-id';
const PEER_EVENT = 'sologsb:peer-draft';
const ABSORBED_EVENT = 'sologsb:branch-absorbed';

export interface BranchRegistry {
  branches: {
    branchId: string;
    label: string;
    updatedAt: string;
    absorbedBy?: string;
    absorbedLabel?: string;
  }[];
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function draftKey(branchId: string): string {
  return `${DRAFT_PREFIX}${branchId}`;
}

function readRegistry(): BranchRegistry {
  return safeParse<BranchRegistry>(localStorage.getItem(REGISTRY_KEY), { branches: [] });
}

function writeRegistry(registry: BranchRegistry): void {
  localStorage.setItem(REGISTRY_KEY, JSON.stringify(registry));
}

function upsertBranch(branchId: string, label: string, patch: Partial<BranchRegistry['branches'][number]> = {}): void {
  const registry = readRegistry();
  const index = registry.branches.findIndex((item) => item.branchId === branchId);
  const entry = { branchId, label, updatedAt: new Date().toISOString(), ...patch };
  if (index >= 0) registry.branches[index] = { ...registry.branches[index], ...entry };
  else registry.branches.push(entry);
  writeRegistry(registry);
}

export function makeBranchId(): string {
  return `branch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 页签启动：恢复/生成分支，迁移旧单键草稿，登记分支心跳 */
export function initBranch(draft: ExperimentProcess): { branchId: string; label: string } {
  let branchId = sessionStorage.getItem(SESSION_BRANCH_KEY) ?? '';
  if (!branchId) {
    branchId = makeBranchId();
    sessionStorage.setItem(SESSION_BRANCH_KEY, branchId);
  }
  const label = draft.sync?.branchLabel ?? `页签 ${new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date())}`;
  const existing = localStorage.getItem(draftKey(branchId));
  if (!existing) {
    // 首次为该分支建草稿：优先迁移旧的单键草稿
    const legacyRaw = localStorage.getItem(LEGACY_KEY);
    if (legacyRaw && !localStorage.getItem(`${REGISTRY_KEY}-bootstrapped`)) {
      const legacy = safeParse<ExperimentProcess | null>(legacyRaw, null);
      if (legacy?.id && Array.isArray(legacy.steps)) {
        saveDraft(branchId, label, legacy);
        localStorage.setItem(`${REGISTRY_KEY}-bootstrapped`, '1');
        return { branchId, label };
      }
    }
    saveDraft(branchId, label, draft);
  }
  upsertBranch(branchId, label);
  return { branchId, label };
}

export function saveDraft(branchId: string, label: string, process: ExperimentProcess): void {
  localStorage.setItem(draftKey(branchId), JSON.stringify(process));
  upsertBranch(branchId, label);
}

export function loadDraft(branchId: string): ExperimentProcess | null {
  const draft = safeParse<ExperimentProcess | null>(localStorage.getItem(draftKey(branchId)), null);
  return draft?.id && Array.isArray(draft.steps) ? draft : null;
}

/** 列出其它页签草稿（含已被本分支合并吸收的，吸收后标记不可重复合并） */
export function listPeerDrafts(currentBranchId: string): PeerDraft[] {
  const registry = readRegistry();
  return registry.branches
    .filter((entry) => entry.branchId !== currentBranchId)
    .map((entry) => {
      const process = loadDraft(entry.branchId);
      if (!process) return null;
      return {
        branchId: entry.branchId,
        label: entry.absorbedLabel ? `${entry.label}（已并入 ${entry.absorbedLabel}）` : entry.label,
        updatedAt: entry.updatedAt,
        process
      };
    })
    .filter((peer): peer is PeerDraft => peer !== null);
}

/** 合并完成后：吸收对端分支，并通知对端页签 */
export function absorbPeer(currentBranchId: string, currentLabel: string, peer: PeerDraft): void {
  const registry = readRegistry();
  const entry = registry.branches.find((item) => item.branchId === peer.branchId);
  if (entry) {
    entry.absorbedBy = currentBranchId;
    entry.absorbedLabel = currentLabel;
    entry.updatedAt = new Date().toISOString();
    writeRegistry(registry);
  }
  try {
    window.dispatchEvent(new CustomEvent(ABSORBED_EVENT, { detail: { branchId: peer.branchId, by: currentLabel } }));
  } catch {
    /* CustomEvent 不可用时忽略通知 */
  }
}

/** 当前页签是否已被别的页签合并吸收（storage 事件触发刷新时检测） */
export function getAbsorbedNotice(currentBranchId: string): { byLabel: string } | null {
  const entry = readRegistry().branches.find((item) => item.branchId === currentBranchId);
  if (entry?.absorbedBy && entry.absorbedBy !== currentBranchId && entry.absorbedLabel) {
    return { byLabel: entry.absorbedLabel };
  }
  return null;
}

export function savePendingMerge(pending: PendingMerge): void {
  localStorage.setItem(`${PENDING_PREFIX}${pending.id}`, JSON.stringify(pending));
}

export function listPendingMerges(): PendingMerge[] {
  const result: PendingMerge[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key?.startsWith(PENDING_PREFIX)) {
      const pending = safeParse<PendingMerge | null>(localStorage.getItem(key), null);
      if (pending?.remote?.id) result.push(pending);
    }
  }
  return result.sort((a, b) => b.at.localeCompare(a.at));
}

export function removePendingMerge(id: string): void {
  localStorage.removeItem(`${PENDING_PREFIX}${id}`);
}

export function exportDraft(process: ExperimentProcess): string {
  return JSON.stringify({ exportedAt: new Date().toISOString(), process }, null, 2);
}

export function importDraft(raw: string): ExperimentProcess {
  const parsed = JSON.parse(raw) as { process?: ExperimentProcess } | ExperimentProcess;
  const process = 'process' in parsed && parsed.process ? parsed.process : (parsed as ExperimentProcess);
  if (!process?.id || !Array.isArray(process.steps)) {
    throw new Error('草稿文件格式不正确：缺少流程或步骤数据。');
  }
  return clone(process);
}

/** 广播“我有新草稿”，供其它页签即时刷新对端列表（storage 事件天然跨页签） */
export function notifyPeers(branchId: string, label: string): void {
  try {
    localStorage.setItem(
      'sologsb-1027-heartbeat',
      JSON.stringify({ branchId, label, at: new Date().toISOString() })
    );
    window.dispatchEvent(new CustomEvent(PEER_EVENT, { detail: { branchId, label } }));
  } catch {
    /* ignore */
  }
}

export function subscribePeerEvents(handler: () => void): () => void {
  const onPeer = () => handler();
  const onStorage = (event: StorageEvent) => {
    if (!event.key) return;
    if (
      event.key === REGISTRY_KEY ||
      event.key === 'sologsb-1027-heartbeat' ||
      event.key.startsWith(DRAFT_PREFIX)
    ) {
      handler();
    }
  };
  window.addEventListener(PEER_EVENT, onPeer);
  window.addEventListener(ABSORBED_EVENT, onPeer);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(PEER_EVENT, onPeer);
    window.removeEventListener(ABSORBED_EVENT, onPeer);
    window.removeEventListener('storage', onStorage);
  };
}
