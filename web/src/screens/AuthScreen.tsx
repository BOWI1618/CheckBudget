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
        {/* Слева — обещание, справа — форма. Экран входа единственный, где
            человек ещё ничего о приложении не знает: одна строка о том,
            что оно делает, стоит здесь больше, чем красивая рамка. */}
        <div>
          <div className="auth__brand">
            <span className="topnav__mark"><Icon name="chart" size={20} /></span>
            CheckBudget
          </div>
          <h1 className="auth__pitch">Бюджет на двоих,<br />который считает сам</h1>
          <p className="auth__lead">
            Расход добавляется в три касания на телефоне и появляется
            у второго участника сразу — без обновления страницы и без потерь
            при плохой связи.
          </p>
          <ul className="auth__points">
            <li><Icon name="check" size={16} />Мультивалютность с замороженным курсом операции</li>
            <li><Icon name="check" size={16} />Работает офлайн, отправляет изменения при подключении</li>
            <li><Icon name="check" size={16} />Роли: владелец, участник, наблюдатель</li>
          </ul>
        </div>

        <form className="auth__form" onSubmit={submit}>
          <div className="segmented segmented--full">
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
