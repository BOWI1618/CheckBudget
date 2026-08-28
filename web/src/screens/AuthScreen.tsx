import { useState, type FormEvent } from 'react';
import { store } from '../data/store.js';
import { ApiError } from '../data/api.js';
import { Button, Field } from '../components/ui.js';
import { Icon } from '../components/Icon.js';

export function AuthScreen() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'login') await store.login(email, password);
      else await store.register(email, password, displayName);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось подключиться к серверу');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth__box">
        <div className="auth__brand">
          <Icon name="chart" size={26} />
          CheckBudget
        </div>
        <p className="auth__lead">
          Учёт личного и семейного бюджета. Работает на телефоне и компьютере
          одновременно — изменения появляются на всех устройствах сразу.
        </p>

        <form className="card card--pad stack" onSubmit={submit}>
          <div className="segmented">
            <button type="button" className={`segmented__item ${mode === 'login' ? 'is-active' : ''}`}
                    onClick={() => { setMode('login'); setError(null); }}>
              Вход
            </button>
            <button type="button" className={`segmented__item ${mode === 'register' ? 'is-active' : ''}`}
                    onClick={() => { setMode('register'); setError(null); }}>
              Регистрация
            </button>
          </div>

          {mode === 'register' && (
            <Field label="Как вас зовут">
              <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)}
                     placeholder="Иван" autoComplete="name" required maxLength={80} />
            </Field>
          )}

          <Field label="Email">
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                   placeholder="ivan@example.com" autoComplete="email" required />
          </Field>

          <Field label="Пароль" hint={mode === 'register' ? 'Минимум 8 символов' : undefined}>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                   autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                   required minLength={mode === 'register' ? 8 : 1} />
          </Field>

          {error && <div className="banner banner--error"><Icon name="warning" size={16} />{error}</div>}

          <Button type="submit" variant="primary" size="lg" full disabled={busy}>
            {busy ? 'Подождите…' : mode === 'login' ? 'Войти' : 'Создать аккаунт'}
          </Button>
        </form>
      </div>
    </div>
  );
}
