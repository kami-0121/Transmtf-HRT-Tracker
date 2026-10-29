import React, { useEffect, useState } from 'react';
import { Check, Copy, Fingerprint, KeyRound, Loader2, Smartphone, Trash2 } from 'lucide-react';
import apiClient from '../api/client';
import { useTranslation } from '../contexts/LanguageContext';
import { useDialog } from '../contexts/DialogContext';
import { useSecurityPassword } from '../contexts/SecurityPasswordContext';
import { canUsePasskeys, createPasskey, forgetPasskey, newPrfInput, PasskeyCancelledError, PasskeyUnsupportedError } from '../utils/passkey';

/** A short device name for passkey / device lists, from the user agent. */
function deviceName(ua = navigator.userAgent): string {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return ua.slice(0, 40);
}

const formatDate = (value: number | string) => new Date(value).toLocaleString(undefined, {
  year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
});

/** Shown once after a recovery key is created: copy it now, it is never shown again. */
export const RecoveryKeyCard: React.FC<{ recoveryKey: string; onDone: () => void }> = ({ recoveryKey, onDone }) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      setCopied(true);
    } catch {
      // Clipboard blocked: the key is selectable text.
    }
  };
  return (
    <div className="rounded-2xl border-2 border-amber-300 bg-amber-50 p-4 dark:bg-amber-950/30">
      <p className="flex items-center gap-2 font-bold text-amber-800 dark:text-amber-200">
        <KeyRound size={18} /> {t('security.recovery.title')}
      </p>
      <p className="mt-1 text-xs text-amber-800/80 dark:text-amber-200/80">{t('security.recovery.saveNow')}</p>
      <p className="mt-3 select-all break-all rounded-xl bg-white px-3 py-3 text-center font-mono text-base font-bold tracking-wider text-gray-900 dark:bg-black/40 dark:text-gray-100">
        {recoveryKey}
      </p>
      <div className="mt-3 flex gap-2">
        <button type="button" onClick={copy}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-amber-300 px-3 py-2 text-sm font-medium text-amber-800 dark:text-amber-200">
          {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? t('security.recovery.copied') : t('security.recovery.copy')}
        </button>
        <button type="button" onClick={onDone}
          className="flex-1 rounded-xl bg-amber-500 px-3 py-2 text-sm font-semibold text-white">
          {t('security.recovery.done')}
        </button>
      </div>
    </div>
  );
};

/**
 * D1 backend: the ways in besides the PIN (as AtDo) — this device's 7-day
 * remembering, other remembered devices, passkeys and the recovery key.
 */
const SecurityKeysPanel: React.FC = () => {
  const { t } = useTranslation();
  const { showDialog } = useDialog();
  const { status, refreshStatus, securityPassword, unlockTokenId, rememberedUntil, acceptGrant } = useSecurityPassword();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [newRecoveryKey, setNewRecoveryKey] = useState<string | null>(null);
  const [passkeysUsable, setPasskeysUsable] = useState(false);

  useEffect(() => {
    canUsePasskeys().then(setPasskeysUsable);
    refreshStatus();
  }, [refreshStatus]);

  if (!securityPassword) return null;   // locked: the PIN gate is showing

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setMessage('');
    try {
      await action();
      await refreshStatus();
    } finally {
      setBusy(null);
    }
  };

  const setRemembered = (remember: boolean) => run('remember', async () => {
    const response = await apiClient.reissueToken(securityPassword, remember);
    if (response.success && response.data) acceptGrant(response.data);
    else setMessage(response.error || t('common.error'));
  });

  const revokeOthers = async () => {
    if (await showDialog('confirm', t('security.devices.revokeConfirm')) !== 'confirm') return;
    run('revoke', async () => {
      const response = await apiClient.revokeOtherDevices(unlockTokenId ?? '');
      setMessage(response.success ? t('security.devices.revoked') : (response.error || t('common.error')));
    });
  };

  const addPasskey = () => run('passkey', async () => {
    try {
      const prfInput = newPrfInput();
      const secret = await createPasskey(prfInput);
      const response = await apiClient.addPasskey({
        password: securityPassword, credential_id: secret.credentialId, prf_input: prfInput, prf_output: secret.prfOutput, label: deviceName(),
      });
      if (response.success) setMessage(t('security.passkeys.added'));
      else {
        forgetPasskey(secret.credentialId);
        setMessage(response.error || t('common.error'));
      }
    } catch (error) {
      if (error instanceof PasskeyCancelledError) return;
      setMessage(error instanceof PasskeyUnsupportedError ? t('security.passkeys.unsupported') : (error instanceof Error ? error.message : t('common.error')));
    }
  });

  const removePasskey = async (id: string, credentialId: string) => {
    if (await showDialog('confirm', t('security.passkeys.removeConfirm')) !== 'confirm') return;
    run(`passkey-${id}`, async () => {
      const response = await apiClient.removePasskey(id);
      if (response.success) forgetPasskey(credentialId);
    });
  };

  const regenerateRecovery = async () => {
    if (status?.has_recovery_key && await showDialog('confirm', t('security.recovery.regenerateConfirm')) !== 'confirm') return;
    run('recovery', async () => {
      const response = await apiClient.regenerateRecoveryKey(securityPassword);
      if (response.success && response.data) setNewRecoveryKey(response.data.recovery_key);
      else setMessage(response.error || t('common.error'));
    });
  };

  const sectionClass = 'glass-card rounded-2xl p-5 space-y-3';
  const titleClass = 'flex items-center gap-2 font-bold';
  const smallButton = 'inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition disabled:opacity-50';
  const spinner = (key: string) => busy === key && <Loader2 size={14} className="animate-spin" />;

  return (
    <div className="space-y-4">
      {message && (
        <div className="rounded-xl border px-3 py-2 text-sm" style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>{message}</div>
      )}

      {/* This device */}
      <section className={sectionClass}>
        <h3 className={titleClass} style={{ color: 'var(--text-primary)' }}><Smartphone size={18} className="text-pink-500" /> {t('security.device.title')}</h3>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          {rememberedUntil
            ? t('security.device.remembered').replace('{date}', formatDate(rememberedUntil))
            : t('security.device.session')}
        </p>
        <button type="button" disabled={!!busy} onClick={() => setRemembered(!rememberedUntil)}
          className={smallButton} style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
          {spinner('remember')}
          {rememberedUntil ? t('security.device.forget') : t('security.remember7d')}
        </button>

        {!!status?.devices?.length && (
          <div className="pt-2">
            <p className="mb-1 text-xs font-semibold" style={{ color: 'var(--text-tertiary)' }}>{t('security.devices.title')}</p>
            <ul className="space-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
              {status.devices.map(d => (
                <li key={d.id} className="flex justify-between gap-2">
                  <span className="truncate">{deviceName(d.label ?? '')}{d.id === unlockTokenId ? ` · ${t('security.devices.current')}` : ''}</span>
                  <span className="shrink-0">{t('security.devices.until').replace('{date}', formatDate(d.expires_at))}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <button type="button" disabled={!!busy} onClick={revokeOthers}
          className={smallButton} style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
          {spinner('revoke')} {t('security.devices.revokeOthers')}
        </button>
      </section>

      {/* Passkeys */}
      <section className={sectionClass}>
        <h3 className={titleClass} style={{ color: 'var(--text-primary)' }}><Fingerprint size={18} className="text-pink-500" /> {t('security.passkeys.title')}</h3>
        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('security.passkeys.desc')}</p>
        {status?.passkeys?.length ? (
          <ul className="space-y-2">
            {status.passkeys.map(p => (
              <li key={p.id} className="flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-sm" style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
                <span className="truncate">{p.label || t('security.passkeys.title')} · {formatDate(p.created_at)}</span>
                <button type="button" disabled={!!busy} onClick={() => removePasskey(p.id, p.credential_id)} aria-label={t('security.passkeys.remove')}
                  className="shrink-0 text-red-500 disabled:opacity-50">
                  {busy === `passkey-${p.id}` ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {passkeysUsable ? (
          <button type="button" disabled={!!busy} onClick={addPasskey}
            className={smallButton} style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
            {spinner('passkey')} <Fingerprint size={14} /> {t('security.passkeys.add')}
          </button>
        ) : (
          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('security.passkeys.unsupported')}</p>
        )}
      </section>

      {/* Recovery key */}
      <section className={sectionClass}>
        <h3 className={titleClass} style={{ color: 'var(--text-primary)' }}><KeyRound size={18} className="text-pink-500" /> {t('security.recovery.title')}</h3>
        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          {status?.has_recovery_key ? t('security.recovery.has') : t('security.recovery.missing')}
        </p>
        {newRecoveryKey ? (
          <RecoveryKeyCard recoveryKey={newRecoveryKey} onDone={() => setNewRecoveryKey(null)} />
        ) : (
          <button type="button" disabled={!!busy} onClick={regenerateRecovery}
            className={smallButton} style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
            {spinner('recovery')} {status?.has_recovery_key ? t('security.recovery.regenerate') : t('security.recovery.create')}
          </button>
        )}
      </section>
    </div>
  );
};

export default SecurityKeysPanel;
