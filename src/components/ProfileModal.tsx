import React, { useRef, useState } from 'react';
import { Camera, Loader2, User, UserRound, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useTranslation } from '../contexts/LanguageContext';

const AVATAR_PX = 160;
const MAX_NAME = 32;

/**
 * Square-crops an image file to AVATAR_PX and encodes it small (WebP, or JPEG
 * where the browser cannot encode WebP) so it fits the profile row on the server.
 */
async function toAvatarDataUrl(file: File): Promise<string> {
    const url = URL.createObjectURL(file);
    try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error('decode'));
            el.src = url;
        });
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        if (!side) throw new Error('empty');
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = AVATAR_PX;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('canvas');
        ctx.fillStyle = '#fff';   // JPEG has no alpha: transparent areas become white
        ctx.fillRect(0, 0, AVATAR_PX, AVATAR_PX);
        ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, AVATAR_PX, AVATAR_PX);
        const webp = canvas.toDataURL('image/webp', 0.85);
        return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.85);
    } finally {
        URL.revokeObjectURL(url);
    }
}

/** Edit display name, avatar and the overview greeting (D1 backend). */
const ProfileModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
    const { user, updateProfile } = useAuth();
    const { t } = useTranslation();
    const fileRef = useRef<HTMLInputElement>(null);
    const [name, setName] = useState(user?.displayName || user?.username || '');
    // undefined = unchanged, null = back to the Google photo, string = new upload
    const [avatar, setAvatar] = useState<string | null | undefined>(undefined);
    const [greet, setGreet] = useState(user?.greet !== false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    const preview = avatar === undefined
        ? user?.avatarUrl
        : avatar === null ? user?.googleAvatarUrl : avatar;
    const showsCustom = avatar === undefined ? !!user?.hasCustomAvatar : avatar !== null;

    const pickFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        setError('');
        try {
            setAvatar(await toAvatarDataUrl(file));
        } catch {
            setError(t('profile.imageError'));
        }
    };

    const save = async () => {
        const trimmed = name.trim();
        if (!trimmed) {
            setError(t('profile.nameRequired'));
            return;
        }
        setSaving(true);
        setError('');
        const failure = await updateProfile({
            display_name: trimmed,
            greet,
            ...(avatar !== undefined ? { avatar } : {}),
        });
        setSaving(false);
        if (failure) setError(failure);
        else onClose();
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
            onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}>
            <div className="w-full max-w-md rounded-3xl p-6 shadow-xl" style={{ background: 'var(--bg-card)' }}>
                <div className="mb-5 flex items-center justify-between">
                    <h3 className="flex items-center gap-2 text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
                        <UserRound size={22} className="text-pink-500" />
                        {t('profile.title')}
                    </h3>
                    <button onClick={onClose} disabled={saving} aria-label={t('btn.cancel') || 'Cancel'}
                        className="flex h-8 w-8 items-center justify-center rounded-xl" style={{ color: 'var(--text-tertiary)' }}>
                        <X size={18} />
                    </button>
                </div>

                <div className="flex flex-col items-center gap-3">
                    <button type="button" onClick={() => fileRef.current?.click()} className="relative" aria-label={t('profile.upload')}>
                        <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-full bg-pink-100">
                            {preview
                                ? <img src={preview} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" />
                                : <User size={40} className="text-pink-600" />}
                        </div>
                        <span className="absolute bottom-0 right-0 flex h-8 w-8 items-center justify-center rounded-full border-2 text-white accent-bg-gradient"
                            style={{ borderColor: 'var(--bg-card)' }}>
                            <Camera size={15} />
                        </span>
                    </button>
                    <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={pickFile} />
                    <div className="flex flex-wrap justify-center gap-2 text-xs">
                        <button type="button" onClick={() => fileRef.current?.click()}
                            className="rounded-lg border px-3 py-1.5 font-medium btn-press-glass"
                            style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
                            {t('profile.upload')}
                        </button>
                        {showsCustom && (
                            <button type="button" onClick={() => setAvatar(null)}
                                className="rounded-lg border px-3 py-1.5 font-medium btn-press-glass"
                                style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
                                {t('profile.useGoogle')}
                            </button>
                        )}
                    </div>
                </div>

                <label className="mt-5 mb-2 block text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                    {t('profile.name')}
                </label>
                <input
                    value={name}
                    maxLength={MAX_NAME}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="nickname"
                    className="w-full rounded-xl border px-4 py-3 focus:outline-none focus:ring-2 focus:ring-pink-500"
                    style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-card-hover)', color: 'var(--text-primary)' }}
                    placeholder={t('profile.namePlaceholder')}
                />

                <label className="mt-4 flex cursor-pointer items-center justify-between gap-3 rounded-xl border px-4 py-3"
                    style={{ borderColor: 'var(--border-primary)' }}>
                    <span>
                        <span className="block text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{t('profile.greet')}</span>
                        <span className="block text-xs" style={{ color: 'var(--text-tertiary)' }}>
                            {t('profile.greetDesc').replace('{name}', name.trim() || '…')}
                        </span>
                    </span>
                    <input type="checkbox" checked={greet} onChange={(e) => setGreet(e.target.checked)} className="h-5 w-5 accent-pink-500" />
                </label>

                <p className="mt-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('profile.syncNote')}</p>

                {error && <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

                <div className="mt-5 flex gap-3">
                    <button onClick={onClose} disabled={saving}
                        className="flex-1 rounded-xl border px-4 py-3 text-sm font-medium"
                        style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
                        {t('btn.cancel') || 'Cancel'}
                    </button>
                    <button onClick={save} disabled={saving}
                        className="flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold text-white glass-btn-primary btn-press-glass disabled:opacity-60">
                        {saving && <Loader2 size={16} className="animate-spin" />}
                        {t('profile.save')}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ProfileModal;
