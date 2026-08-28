import { useSyncExternalStore, useMemo } from 'react';
import type { Category } from '@checkbudget/shared';
import { store, type AppState, type BudgetData } from './store.js';

export const useApp = (): AppState => useSyncExternalStore(store.subscribe, store.getState, store.getState);

export function useBudgetData(): BudgetData | null {
  return useApp().data;
}

export interface CategoryNode extends Category {
  children: Category[];
}

/** Дерево категорий: два уровня, отсортированные по порядку и названию. */
export function useCategoryTree(kind: 'expense' | 'income'): CategoryNode[] {
  const data = useBudgetData();
  return useMemo(() => {
    const all = (data?.categories ?? []).filter((c) => c.kind === kind);
    const roots = all.filter((c) => !c.parentId);
    return roots.map((root) => ({
      ...root,
      children: all.filter((c) => c.parentId === root.id),
    }));
  }, [data?.categories, kind]);
}

export function useLookups() {
  const data = useBudgetData();
  return useMemo(() => ({
    categoryById: new Map((data?.categories ?? []).map((c) => [c.id, c])),
    accountById: new Map((data?.accounts ?? []).map((a) => [a.id, a])),
    memberById: new Map((data?.members ?? []).map((m) => [m.userId, m])),
  }), [data?.categories, data?.accounts, data?.members]);
}

/** Право на запись проверяется и на сервере — здесь только чтобы не показывать бесполезные кнопки. */
export function useCanEdit(): boolean {
  const role = useApp().data?.budget.role;
  return role === 'owner' || role === 'editor';
}
