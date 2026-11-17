import { useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent } from 'react';
import { ErrorBox, Spinner, useToast } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useTitle } from '../lib/title';

interface Setup {
  secret: string;
  otpauthUrl: string;
}

/**
 * Two-step login with an authenticator app:
 *   off → "Turn on" → scan the QR (or type the key) → enter the first code → backup codes (shown once) → on
 *   on  → enter a code → off   ·   enter a code → new backup codes
 * The QR is drawn here in the browser from the otpauth:// link: the secret never goes to another site.
 */
export function SecurityPage() {
  useTitle('Security');
  const { user, loading } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!setup) return setQr(null);
    // SVG, not canvas: no pixels to scale, and it works without a canvas (tests).
    QRCode.toString(setup.otpauthUrl, { type: 'svg', margin: 1 }).then(
      (svg) => setQr(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`),
      () => setQr(null),
    );
  }, [setup]);

  if (loading || !user) return <Spinner />;
  const on = user.twoFactorEnabled === true;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setCode('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const refreshUser = () => queryClient.invalidateQueries({ queryKey: ['me'] });

  const start = () => run(async () => setSetup(await api<Setup>('/auth/2fa/setup', { method: 'POST' })));
  const enable = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => {
      const res = await api<{ backupCodes: string[] }>('/auth/2fa/enable', { method: 'POST', body: { code } });
      setSetup(null);
      setBackupCodes(res.backupCodes);
      await refreshUser();
      toast('Two-step login is on', 'success');
    });
  };
  const disable = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => {
      await api('/auth/2fa/disable', { method: 'POST', body: { code } });
      setBackupCodes(null);
      await refreshUser();
      toast('Two-step login is off', 'success');
    });
  };
  const newCodes = () =>
    run(async () => {
      const res = await api<{ backupCodes: string[] }>('/auth/2fa/backup-codes', { method: 'POST', body: { code } });
      setBackupCodes(res.backupCodes);
    });

  const codeInput = (
    <input
      className="input text-center font-mono tracking-widest"
      aria-label="Code from your app"
      placeholder="123456"
      inputMode="numeric"
      autoComplete="one-time-code"
      required
      maxLength={12}
      value={code}
      onChange={(e) => setCode(e.target.value.trim())}
    />
  );

  return (
    <div className="mx-auto max-w-xl space-y-6 animate-fade-up">
      <h1 className="text-2xl font-bold">Security</h1>
      <section className="card space-y-4 p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-semibold">Two-step login</h2>
            <p className="text-sm text-slate-500">After your password, also enter a code from an authenticator app (Google or Microsoft Authenticator).</p>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${on ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
            {on ? 'On' : 'Off'}
          </span>
        </div>

        {!on && !setup && (
          <button className="btn-primary" onClick={start} disabled={busy}>
            Turn on
          </button>
        )}

        {!on && setup && (
          <form className="space-y-4" onSubmit={enable}>
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              <li>Open your authenticator app and scan this code.</li>
              <li>Type the 6-digit code it shows to finish.</li>
            </ol>
            {qr ? <img src={qr} alt="QR code for your authenticator app" className="mx-auto h-48 w-48 rounded-lg bg-white p-2" /> : <Spinner label="Drawing QR code" />}
            <p className="text-center text-xs text-slate-500">
              Can't scan? Enter this key: <code className="select-all break-all font-mono">{setup.secret}</code>
            </p>
            <div className="flex gap-2">
              {codeInput}
              <button className="btn-primary whitespace-nowrap" disabled={busy}>
                Turn on
              </button>
            </div>
          </form>
        )}

        {on && (
          <form className="space-y-3" onSubmit={disable}>
            <p className="text-sm text-slate-500">Enter a current code (or a backup code) to turn it off or to get new backup codes.</p>
            <div className="flex flex-wrap gap-2">
              {codeInput}
              <button className="btn-ghost text-rose-600" disabled={busy}>
                Turn off
              </button>
              <button type="button" className="btn-ghost" disabled={busy || code.length !== 6} onClick={newCodes}>
                New backup codes
              </button>
            </div>
          </form>
        )}

        {error && <ErrorBox message={error} />}
      </section>

      {backupCodes && (
        <section className="card space-y-3 border-amber-300 p-6">
          <h2 className="font-semibold">Your backup codes</h2>
          <p className="text-sm text-slate-500">Each one works once if you lose your phone. Save them somewhere safe: they won't be shown again.</p>
          <ul className="grid grid-cols-2 gap-2 font-mono text-sm" aria-label="Backup codes">
            {backupCodes.map((c) => (
              <li key={c} className="rounded-lg bg-slate-100 px-3 py-2 text-center dark:bg-slate-800">
                {c}
              </li>
            ))}
          </ul>
          <button className="btn-ghost" onClick={() => navigator.clipboard?.writeText(backupCodes.join('\n'))}>
            Copy all
          </button>
        </section>
      )}
    </div>
  );
}
