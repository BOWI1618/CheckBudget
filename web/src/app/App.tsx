import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom';
import type { Transaction } from '@checkbudget/shared';
import { store } from '../data/store.js';
import { useApp } from '../data/hooks.js';
import { startSync, stopSync, installConnectivityWatchers } from '../data/sync.js';
import { currentPeriod } from '../lib/dates.js';
import { Layout } from './Layout.js';
import { AuthScreen } from '../screens/AuthScreen.js';
import { Dashboard } from '../screens/Dashboard.js';
import { TransactionsScreen } from '../screens/TransactionsScreen.js';
import { AnalyticsScreen } from '../screens/AnalyticsScreen.js';
import { BudgetsScreen } from '../screens/BudgetsScreen.js';
import { AccountsScreen } from '../screens/AccountsScreen.js';
import { CategoriesScreen } from '../screens/CategoriesScreen.js';
import { MembersScreen } from '../screens/MembersScreen.js';
import { SettingsScreen } from '../screens/SettingsScreen.js';
import { MoreScreen } from '../screens/MoreScreen.js';
import { AddTransactionSheet } from '../screens/AddTransactionSheet.js';
import { ConflictDialog } from '../components/ConflictDialog.js';
import { Skeleton } from '../components/ui.js';

export function App() {
  const app = useApp();

  useEffect(() => {
    void store.bootstrap();
    installConnectivityWatchers();
    return () => stopSync();
  }, []);

  // Realtime-подписка живёт ровно столько, сколько выбран бюджет.
  useEffect(() => {
    if (app.status === 'ready' && app.currentBudgetId) startSync(app.currentBudgetId);
  }, [app.status, app.currentBudgetId]);

  if (app.status === 'loading') {
    return (
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 700, margin: '0 auto' }}>
        <Skeleton height={100} radius={16} />
        <Skeleton height={200} radius={16} />
        <Skeleton height={200} radius={16} />
      </div>
    );
  }

  if (app.status === 'anon') return <AuthScreen />;

  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  );
}

function Shell() {
  const [period, setPeriod] = useState(currentPeriod());

  // Снимок отдаёт операции только за последние месяцы. Стоит пользователю
  // пролистать назад — недостающее подтягивается один раз и остаётся в кеше.
  useEffect(() => {
    void store.ensurePeriodLoaded(period);
  }, [period]);

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const navigate = useNavigate();

  const openAdd = useCallback(() => { setEditing(null); setAdding(true); }, []);
  const openEdit = useCallback((tx: Transaction) => { setEditing(tx); setAdding(true); }, []);
  const close = useCallback(() => { setAdding(false); setEditing(null); }, []);

  return (
    <>
      <Layout period={period} onPeriodChange={setPeriod} onAdd={openAdd}>
        <Routes>
          <Route path="/" element={
            <Dashboard period={period} onAdd={openAdd} onSelect={openEdit} onNavigate={navigate} />
          } />
          <Route path="/transactions" element={
            <TransactionsScreen period={period} onEdit={openEdit} onAdd={openAdd} />
          } />
          <Route path="/analytics" element={<AnalyticsScreen period={period} />} />
          <Route path="/budgets" element={<BudgetsScreen period={period} />} />
          <Route path="/accounts" element={<AccountsScreen />} />
          <Route path="/categories" element={<CategoriesScreen />} />
          <Route path="/members" element={<MembersScreen />} />
          <Route path="/settings" element={<SettingsScreen />} />
          <Route path="/more" element={<MoreScreen />} />
          <Route path="*" element={<Dashboard period={period} onAdd={openAdd} onSelect={openEdit} onNavigate={navigate} />} />
        </Routes>
      </Layout>

      <AddTransactionSheet open={adding} onClose={close} editing={editing} />
      <ConflictDialog />
    </>
  );
}
