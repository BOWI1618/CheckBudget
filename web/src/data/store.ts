import type {
  Account, Budget, Category, Goal, BudgetLimit, Member, SyncEvent, Transaction,
} from '@checkbudget/shared';
import { api, ApiError, NetworkError, setAccessToken, setUnauthorizedHandler, CLIENT_ID } from './api.js';
import { idb, type QueuedMutation } from './idb.js';

export interface LimitWithProgress extends BudgetLimit {
  spentMinor: number;
  unconvertedCount: number;
}

export interface BudgetData {
  seq: number;
  budget: { id: string; name: string; baseCurrency: string; role: Budget['role'] };
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  limits: LimitWithProgress[];
  goals: Goal[];
  members: Member[];
}

/** Конфликт, который нельзя разрешить автоматически — решает пользователь. */
export interface Conflict {
  entity: 'transaction';
  id: string;
  fields: string[];
  mine: Record<string, unknown>;
  theirs: Record<string, unknown>;
  base: Record<string, unknown>;
  actorName: string | null;
}

export interface Toast {
  id: string;
  kind: 'info' | 'error' | 'success';
  text: string;
}

export interface AppState {
  status: 'loading' | 'anon' | 'ready';
  user: { id: string; email: string; displayName: string } | null;
  settings: { baseCurrency: string; theme: 'light' | 'dark' | 'system'; defaultBudgetId: string | null } | null;
  budgets: Budget[];
  currentBudgetId: string | null;
  data: BudgetData | null;
  /** Реальное состояние связи: определяется по результату запросов, а не по navigator.onLine. */
  connection: 'online' | 'offline' | 'connecting';
  queueSize: number;
  conflict: Conflict | null;
  toasts: Toast[];
  /** id операций, изменённых другими участниками только что — для подсветки. */
  highlighted: Record<string, number>;
}

type Listener = () => void;

const initial: AppState = {
  status: 'loading',
  user: null,
  settings: null,
  budgets: [],
  currentBudgetId: null,
  data: null,
  connection: 'connecting',
  queueSize: 0,
  conflict: null,
  toasts: [],
  highlighted: {},
};

class Store {
  private state: AppState = initial;
  private listeners = new Set<Listener>();
  private flushing = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  getState = (): AppState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private patchData(fn: (data: BudgetData) => BudgetData): void {
    if (!this.state.data) return;
    const next = fn(this.state.data);
    this.set({ data: next });
    void idb.putSnapshot(next.budget.id, next);
  }

  toast(kind: Toast['kind'], text: string): void {
    const toast: Toast = { id: crypto.randomUUID(), kind, text };
    this.set({ toasts: [...this.state.toasts, toast] });
    setTimeout(() => {
      this.set({ toasts: this.state.toasts.filter((t) => t.id !== toast.id) });
    }, kind === 'error' ? 6000 : 3500);
  }

  dismissToast(id: string): void {
    this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) });
  }

  // ────────────────────────────── Сессия ──────────────────────────────

  /**
   * Подсказка о последней сессии.
   *
   * Хранится отдельно от токенов (их в localStorage нет и не будет) и содержит
   * только то, что нужно нарисовать интерфейс до подключения к серверу.
   * Без неё офлайн-старт невозможен: приложение не знало бы даже, чей кеш
   * показывать.
   */
  private saveSessionHint(): void {
    try {
      localStorage.setItem('cb_session', JSON.stringify({
        user: this.state.user,
        settings: this.state.settings,
        budgets: this.state.budgets,
        currentBudgetId: this.state.currentBudgetId,
      }));
    } catch { /* приватный режим — офлайн-старт будет недоступен */ }
  }

  private readSessionHint(): Partial<AppState> | null {
    try {
      const raw = localStorage.getItem('cb_session');
      return raw ? (JSON.parse(raw) as Partial<AppState>) : null;
    } catch {
      return null;
    }
  }

  async bootstrap(): Promise<void> {
    setUnauthorizedHandler(() => {
      try { localStorage.removeItem('cb_session'); } catch { /* ignore */ }
      this.set({ status: 'anon', user: null, data: null });
    });

    const result = await api.refresh();
    if (result === 'ok') return this.loadSession();

    if (result === 'offline') {
      // Сервер недоступен — но это не повод требовать вход. Поднимаем
      // приложение из локального кеша и продолжим попытки в фоне.
      const hint = this.readSessionHint();
      const budgetId = hint?.currentBudgetId;
      if (hint?.user && budgetId) {
        const cached = await idb.getSnapshot<BudgetData>(budgetId);
        this.set({
          status: 'ready',
          user: hint.user,
          settings: hint.settings ?? null,
          budgets: hint.budgets ?? [],
          currentBudgetId: budgetId,
          data: cached,
          connection: 'offline',
          queueSize: (await idb.listQueue()).length,
        });
        this.applyTheme(hint.settings?.theme ?? 'system');
        this.scheduleReauth();
        return;
      }
    }

    this.set({ status: 'anon' });
  }

  /** Периодические попытки поднять сессию, пока приложение работает офлайн. */
  private reauthTimer: ReturnType<typeof setInterval> | null = null;

  private scheduleReauth(): void {
    if (this.reauthTimer) return;
    this.reauthTimer = setInterval(async () => {
      if (this.state.connection === 'online') return;
      const result = await api.refresh();
      if (result === 'ok') {
        if (this.reauthTimer) { clearInterval(this.reauthTimer); this.reauthTimer = null; }
        await this.loadSession();
        void this.flushQueue();
      }
    }, 15_000);
  }

  private async loadSession(): Promise<void> {
    const me = await api.get<{ user: AppState['user']; settings: AppState['settings'] }>('/me');
    const budgets = await api.get<{ items: Budget[] }>('/budgets');

    let list = budgets.items;
    if (list.length === 0) {
      // Первый вход: бюджет создаётся сразу, чтобы человек не упирался
      // в пустой экран настройки до первой же операции.
      const created = await api.post<Budget>('/budgets', {
        name: 'Мой бюджет',
        baseCurrency: me.settings?.baseCurrency ?? 'RUB',
      });
      list = [created];
    }

    const preferred = me.settings?.defaultBudgetId;
    const current = list.find((b) => b.id === preferred) ?? list[0]!;

    this.set({ status: 'ready', user: me.user, settings: me.settings, budgets: list });
    this.applyTheme(me.settings?.theme ?? 'system');
    await this.selectBudget(current.id);
    this.saveSessionHint();
  }

  async login(email: string, password: string): Promise<void> {
    const res = await api.post<{ accessToken: string }>('/auth/login', { email, password });
    setAccessToken(res.accessToken);
    await this.loadSession();
  }

  async register(email: string, password: string, displayName: string): Promise<void> {
    const res = await api.post<{ accessToken: string }>('/auth/register', { email, password, displayName });
    setAccessToken(res.accessToken);
    await this.loadSession();
  }

  async logout(): Promise<void> {
    try {
      await api.post('/auth/logout');
    } catch { /* выходим локально в любом случае */ }
    setAccessToken(null);
    await idb.clearAll();
    try { localStorage.removeItem('cb_session'); } catch { /* ignore */ }
    this.state = { ...initial, status: 'anon' };
    for (const listener of this.listeners) listener();
  }

  applyTheme(theme: 'light' | 'dark' | 'system'): void {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }

  async updateSettings(patch: Record<string, unknown>): Promise<void> {
    const res = await api.patch<{ user: AppState['user']; settings: AppState['settings'] }>(
      '/me/settings', patch,
    );
    this.set({ settings: res.settings });
    if (res.settings) this.applyTheme(res.settings.theme);
  }

  // ────────────────────────────── Бюджет ──────────────────────────────

  async selectBudget(budgetId: string): Promise<void> {
    this.set({ currentBudgetId: budgetId, conflict: null });

    // Сначала показываем локальный кеш — приложение открывается мгновенно
    // и остаётся работоспособным без сети.
    const cached = await idb.getSnapshot<BudgetData>(budgetId);
    if (cached) this.set({ data: cached });

    await this.refreshSnapshot(budgetId);
    void this.flushQueue();
  }

  async refreshSnapshot(budgetId: string): Promise<void> {
    try {
      const snapshot = await api.get<BudgetData>(`/budgets/${budgetId}/snapshot`);
      this.set({ data: snapshot, connection: 'online' });
      void idb.putSnapshot(budgetId, snapshot);
    } catch (err) {
      if (err instanceof NetworkError) this.set({ connection: 'offline' });
      else throw err;
    }
  }

  setConnection(connection: AppState['connection']): void {
    if (this.state.connection !== connection) this.set({ connection });
    if (connection === 'online') void this.flushQueue();
  }

  // ─────────────────────── Применение realtime-событий ───────────────────────

  applyEvent(event: SyncEvent): void {
    const data = this.state.data;
    if (!data || data.budget.id !== event.budgetId) return;

    // События идемпотентны при применении: повтор уже применённого seq
    // не должен ничего ломать (это допускается протоколом при переподписке).
    if (event.seq <= data.seq) return;

    // Сравниваем устройства, а не пользователей: изменение, сделанное этим же
    // человеком с телефона, для компьютера является внешним и требует
    // пересчёта производных данных ровно так же, как чужое.
    const isMine = event.actorClientId !== null && event.actorClientId === CLIENT_ID;
    let next: BudgetData = { ...data, seq: event.seq };

    switch (event.entity) {
      case 'transaction': {
        const payload = event.payload as Transaction & { id: string };
        if (event.op === 'delete') {
          next.transactions = next.transactions.filter((t) => t.id !== payload.id);
        } else {
          next.transactions = upsertSorted(next.transactions, payload);
        }
        break;
      }
      case 'account': {
        const payload = event.payload as Account & { id: string };
        next.accounts = event.op === 'delete'
          ? next.accounts.filter((a) => a.id !== payload.id)
          : upsertById(next.accounts, payload);
        break;
      }
      case 'category': {
        const payload = event.payload as Category & { id: string };
        next.categories = event.op === 'delete'
          ? next.categories.filter((c) => c.id !== payload.id)
          : upsertById(next.categories, payload);
        break;
      }
      case 'limit': {
        const payload = event.payload as LimitWithProgress & { id: string };
        next.limits = event.op === 'delete'
          ? next.limits.filter((l) => l.id !== payload.id)
          : upsertById(next.limits, payload);
        break;
      }
      case 'goal': {
        const payload = event.payload as Goal & { id: string };
        next.goals = event.op === 'delete'
          ? next.goals.filter((g) => g.id !== payload.id)
          : upsertById(next.goals, payload);
        break;
      }
      case 'member': {
        const payload = event.payload as { members?: Member[] };
        if (payload.members) next.members = payload.members;
        break;
      }
      case 'budget': {
        const payload = event.payload as { name?: string };
        if (payload.name) next.budget = { ...next.budget, name: payload.name };
        break;
      }
    }

    this.set({ data: next });
    void idb.putSnapshot(next.budget.id, next);

    // Балансы счетов и прогресс лимитов считаются на сервере, поэтому после
    // чужого изменения их нужно перечитать. Своё изменение уже отражено ответом.
    if (!isMine && event.entity === 'transaction') {
      this.set({ highlighted: { ...this.state.highlighted, [event.entityId]: Date.now() } });
      this.refreshDerived();
      const who = event.actorId === this.state.user?.id ? 'Другое устройство' : event.actorName;
      this.toast('info', `${who}: ${describeEvent(event)}`);
    }
  }

  private derivedTimer: ReturnType<typeof setTimeout> | null = null;

  /** Пересчёт производных данных с дебаунсом — пачка событий не должна давать пачку запросов. */
  private refreshDerived(): void {
    if (this.derivedTimer) clearTimeout(this.derivedTimer);
    this.derivedTimer = setTimeout(async () => {
      const budgetId = this.state.currentBudgetId;
      if (!budgetId) return;
      try {
        const [accounts, limits] = await Promise.all([
          api.get<{ items: Account[] }>(`/budgets/${budgetId}/accounts`),
          api.get<{ items: LimitWithProgress[] }>(`/budgets/${budgetId}/limits`),
        ]);
        this.patchData((data) => ({ ...data, accounts: accounts.items, limits: limits.items }));
      } catch { /* обновим при следующем событии */ }
    }, 400);
  }

  // ──────────────────────── Мутации с оптимистичным UI ────────────────────────

  private async send<T>(
    mutation: Omit<QueuedMutation, 'id' | 'createdAt' | 'attempts' | 'lastError'>,
  ): Promise<T> {
    const queued: QueuedMutation = {
      ...mutation,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      attempts: 0,
      lastError: null,
    };
    // Ключ идемпотентности = id элемента очереди. Он создаётся ОДИН раз,
    // поэтому сколько бы раз запрос ни повторился, эффект будет один.
    await idb.enqueue(queued);
    this.set({ queueSize: this.state.queueSize + 1 });
    return this.deliver<T>(queued);
  }

  private async deliver<T>(item: QueuedMutation): Promise<T> {
    const method = item.method.toLowerCase() as 'post' | 'patch' | 'put' | 'del';
    const fn = method === 'del' ? api.del : api[method];
    try {
      const result = await fn<T>(item.path, item.body, item.id);
      await idb.dequeue(item.id);
      this.set({ queueSize: Math.max(0, this.state.queueSize - 1), connection: 'online' });
      this.reconcile(item, result);
      return result;
    } catch (err) {
      if (err instanceof NetworkError) {
        // Не ошибка запроса, а отсутствие связи: мутация остаётся в очереди.
        this.set({ connection: 'offline' });
        this.scheduleRetry();
        throw err;
      }
      // Сервер ответил осмысленно — повторять бессмысленно.
      await idb.dequeue(item.id);
      this.set({ queueSize: Math.max(0, this.state.queueSize - 1) });
      throw err;
    }
  }

  /**
   * Замена оптимистичной записи ответом сервера.
   *
   * Делается здесь, а не в вызывающем коде, потому что мутация может уйти
   * двумя путями: сразу или позже, из очереди после восстановления связи.
   * Во втором случае вызывающего кода уже нет — он завершился с NetworkError.
   * Без этого шага операция навсегда оставалась бы серой «отправляется»
   * и задваивалась бы, когда её же приносило realtime-событие с настоящим id.
   */
  private reconcile(item: QueuedMutation, result: unknown): void {
    if (item.entity !== 'transaction' || !result || typeof result !== 'object') return;
    const saved = result as Transaction;
    if (!saved.id) return;
    this.patchData((data) => ({
      ...data,
      transactions: upsertSorted(
        data.transactions.filter((t) => t.id !== item.localId || t.id === saved.id),
        saved,
      ),
    }));
    this.refreshDerived();
  }

  private scheduleRetry(delay = 2000): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flushQueue();
    }, delay);
  }

  /**
   * Отправка накопленной очереди.
   *
   * Строго последовательно: «создать операцию» и «изменить её же» не должны
   * прийти на сервер в обратном порядке.
   */
  async flushQueue(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const items = await idb.listQueue();
      this.set({ queueSize: items.length });
      for (const item of items) {
        try {
          await this.deliver(item);
        } catch (err) {
          if (err instanceof NetworkError) return; // связи нет — остальное подождёт
          this.toast('error', err instanceof ApiError ? err.message : 'Не удалось отправить изменение');
        }
      }
      this.set({ queueSize: (await idb.listQueue()).length });
    } finally {
      this.flushing = false;
    }
  }

  async addTransaction(input: Record<string, unknown>): Promise<Transaction | null> {
    const data = this.state.data;
    if (!data) return null;
    const localId = `local-${crypto.randomUUID()}`;

    // Оптимистичная запись: пользователь видит результат немедленно,
    // не дожидаясь ответа сервера. Курс здесь ещё не известен — база
    // покажется после подтверждения.
    const optimistic = {
      ...input,
      id: localId,
      budgetId: data.budget.id,
      baseAmountMinor: input.currency === data.budget.baseCurrency ? input.amountMinor : null,
      baseCurrency: data.budget.baseCurrency,
      version: 1,
      createdBy: this.state.user?.id ?? '',
      updatedBy: this.state.user?.id ?? '',
      pending: true,
    } as unknown as Transaction;

    this.patchData((d) => ({ ...d, transactions: upsertSorted(d.transactions, optimistic) }));

    try {
      const saved = await this.send<Transaction>({
        budgetId: data.budget.id,
        method: 'POST',
        path: `/budgets/${data.budget.id}/transactions`,
        body: serializeMoney(input),
        localId,
        entity: 'transaction',
      });
      // Сшивание оптимистичной записи с ответом уже выполнено в deliver().
      return saved;
    } catch (err) {
      if (err instanceof NetworkError) {
        this.toast('info', 'Нет сети — операция сохранена и будет отправлена позже');
        return optimistic;
      }
      this.patchData((d) => ({ ...d, transactions: d.transactions.filter((t) => t.id !== localId) }));
      this.toast('error', err instanceof ApiError ? err.message : 'Не удалось сохранить операцию');
      return null;
    }
  }

  /**
   * Изменение операции с разрешением конфликтов.
   *
   * `base` — состояние на момент начала редактирования. Оно нужно, чтобы при
   * 409 отличить «мы правили разные поля» (сливаем автоматически) от
   * «мы правили одно и то же» (спрашиваем пользователя).
   */
  async updateTransaction(
    id: string,
    patch: Record<string, unknown>,
    base: Transaction,
  ): Promise<boolean> {
    const data = this.state.data;
    if (!data) return false;
    const previous = data.transactions.find((t) => t.id === id);
    if (!previous) return false;

    this.patchData((d) => ({
      ...d,
      transactions: upsertSorted(d.transactions, { ...previous, ...patch, pending: true } as Transaction),
    }));

    try {
      await this.send<Transaction>({
        budgetId: data.budget.id,
        method: 'PATCH',
        path: `/budgets/${data.budget.id}/transactions/${id}`,
        // Версия берётся из снимка, на котором пользователь начал править:
        // именно её сервер сравнивает, чтобы обнаружить конфликт.
        body: serializeMoney({ ...patch, version: base.version }),
        localId: id,
        entity: 'transaction',
      });
      return true;
    } catch (err) {
      if (err instanceof NetworkError) {
        this.toast('info', 'Нет сети — изменение будет отправлено позже');
        return true;
      }
      if (err instanceof ApiError && err.code === 'version_conflict' && err.current) {
        return this.resolveConflict(id, patch, base, err.current as Transaction);
      }
      this.patchData((d) => ({ ...d, transactions: upsertSorted(d.transactions, previous) }));
      this.toast('error', err instanceof ApiError ? err.message : 'Не удалось изменить операцию');
      return false;
    }
  }

  private async resolveConflict(
    id: string,
    patch: Record<string, unknown>,
    base: Transaction,
    theirs: Transaction,
  ): Promise<boolean> {
    const changedByThem = Object.keys(theirs).filter(
      (key) => key !== 'version' && key !== 'updatedAt' && key !== 'updatedBy'
        && Store.asRecord(theirs)[key] !== Store.asRecord(base)[key],
    );
    const overlapping = Object.keys(patch).filter((key) => changedByThem.includes(key));

    if (overlapping.length === 0) {
      // Правки не пересекаются (например, один поменял сумму, другой — комментарий).
      // Сливаем автоматически: пользователю незачем это видеть.
      return this.updateTransaction(id, patch, theirs);
    }

    this.patchData((d) => ({ ...d, transactions: upsertSorted(d.transactions, theirs) }));
    this.set({
      conflict: {
        entity: 'transaction',
        id,
        fields: overlapping,
        mine: patch,
        theirs: Store.asRecord(theirs),
        base: Store.asRecord(base),
        actorName: null,
      },
    });
    return false;
  }

  /** Пользователь выбрал «записать моё» в диалоге конфликта. */
  async keepMine(): Promise<void> {
    const conflict = this.state.conflict;
    if (!conflict) return;
    this.set({ conflict: null });
    const theirs = this.state.data?.transactions.find((t) => t.id === conflict.id);
    if (theirs) await this.updateTransaction(conflict.id, conflict.mine, theirs);
  }

  /** Приведение к индексируемому виду для пофайлового сравнения полей. */
  private static asRecord(value: unknown): Record<string, unknown> {
    return value as Record<string, unknown>;
  }

  /** Пользователь выбрал «оставить чужое». Своё изменение просто отбрасывается. */
  keepTheirs(): void {
    this.set({ conflict: null });
  }

  async deleteTransaction(id: string, version: number): Promise<boolean> {
    const data = this.state.data;
    if (!data) return false;
    const previous = data.transactions.find((t) => t.id === id);
    this.patchData((d) => ({ ...d, transactions: d.transactions.filter((t) => t.id !== id) }));
    try {
      await this.send({
        budgetId: data.budget.id,
        method: 'DELETE',
        path: `/budgets/${data.budget.id}/transactions/${id}`,
        body: { version },
        localId: id,
        entity: 'transaction',
      });
      this.refreshDerived();
      return true;
    } catch (err) {
      if (err instanceof NetworkError) return true;
      if (previous) this.patchData((d) => ({ ...d, transactions: upsertSorted(d.transactions, previous) }));
      this.toast('error', err instanceof ApiError ? err.message : 'Не удалось удалить операцию');
      return false;
    }
  }

  // Простые сущности: оптимистичность здесь не нужна — они меняются редко
  // и не в момент, когда пользователь торопится.

  async saveEntity<T>(
    kind: 'accounts' | 'categories' | 'goals',
    method: 'POST' | 'PATCH' | 'DELETE',
    body: Record<string, unknown>,
    id?: string,
  ): Promise<T | null> {
    const data = this.state.data;
    if (!data) return null;
    const path = `/budgets/${data.budget.id}/${kind}${id ? `/${id}` : ''}`;
    try {
      const result = await this.send<T>({
        budgetId: data.budget.id, method, path,
        body: serializeMoney(body), localId: id ?? null, entity: kind,
      });
      await this.refreshSnapshot(data.budget.id);
      return result;
    } catch (err) {
      this.toast('error', err instanceof ApiError ? err.message : 'Не удалось сохранить');
      return null;
    }
  }

  async setLimit(categoryId: string, period: string, limitMinor: number): Promise<void> {
    const data = this.state.data;
    if (!data) return;
    try {
      await this.send({
        budgetId: data.budget.id, method: 'PUT',
        path: `/budgets/${data.budget.id}/limits`,
        body: { categoryId, period, limitMinor: String(limitMinor) },
        localId: categoryId, entity: 'limit',
      });
      const limits = await api.get<{ items: LimitWithProgress[] }>(`/budgets/${data.budget.id}/limits?period=${period}`);
      this.patchData((d) => ({ ...d, limits: limits.items }));
    } catch (err) {
      this.toast('error', err instanceof ApiError ? err.message : 'Не удалось сохранить лимит');
    }
  }

  async createBudget(name: string, baseCurrency: string): Promise<void> {
    const created = await api.post<Budget>('/budgets', { name, baseCurrency });
    this.set({ budgets: [...this.state.budgets, created] });
    await this.selectBudget(created.id);
  }

  async createInvite(role: 'editor' | 'viewer'): Promise<string | null> {
    const data = this.state.data;
    if (!data) return null;
    try {
      const res = await api.post<{ code: string }>(`/budgets/${data.budget.id}/invites`, {
        role, expiresInHours: 72,
      });
      return res.code;
    } catch (err) {
      this.toast('error', err instanceof ApiError ? err.message : 'Не удалось создать приглашение');
      return null;
    }
  }

  async acceptInvite(code: string): Promise<boolean> {
    try {
      const res = await api.post<{ budgetId: string }>('/invites/accept', { code });
      const budgets = await api.get<{ items: Budget[] }>('/budgets');
      this.set({ budgets: budgets.items });
      await this.selectBudget(res.budgetId);
      this.toast('success', 'Вы присоединились к бюджету');
      return true;
    } catch (err) {
      this.toast('error', err instanceof ApiError ? err.message : 'Не удалось применить приглашение');
      return false;
    }
  }

  async changeMemberRole(userId: string, role: 'editor' | 'viewer'): Promise<void> {
    const data = this.state.data;
    if (!data) return;
    try {
      await api.patch(`/budgets/${data.budget.id}/members/${userId}`, { role });
    } catch (err) {
      this.toast('error', err instanceof ApiError ? err.message : 'Не удалось изменить роль');
    }
  }

  async removeMember(userId: string): Promise<void> {
    const data = this.state.data;
    if (!data) return;
    try {
      await api.del(`/budgets/${data.budget.id}/members/${userId}`);
    } catch (err) {
      this.toast('error', err instanceof ApiError ? err.message : 'Не удалось исключить участника');
    }
  }
}

/** Суммы уходят на сервер строками — тем же контрактом, каким приходят. */
function serializeMoney(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    out[key] = key.endsWith('Minor') && typeof value === 'number' ? String(value) : value;
  }
  return out;
}

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const index = list.findIndex((x) => x.id === item.id);
  if (index === -1) return [...list, item];
  const next = list.slice();
  next[index] = item;
  return next;
}

function upsertSorted(list: Transaction[], item: Transaction): Transaction[] {
  const next = upsertById(list, item);
  return next.sort((a, b) =>
    a.occurredOn === b.occurredOn ? b.id.localeCompare(a.id) : b.occurredOn.localeCompare(a.occurredOn),
  );
}

function describeEvent(event: SyncEvent): string {
  const verb = { insert: 'добавил операцию', update: 'изменил операцию', delete: 'удалил операцию' };
  return verb[event.op];
}

export const store = new Store();
