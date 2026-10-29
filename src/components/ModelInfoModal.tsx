import React from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import { FlaskConical, Pill, BrainCircuit, TrendingUp, Sparkles, X } from 'lucide-react';

const ModelInfoModal = ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) => {
    const { t } = useTranslation();

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 flex items-center justify-center z-[60] animate-in fade-in duration-200 p-4"
            style={{ background: 'var(--bg-overlay)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}>
            <div className="rounded-3xl w-full max-w-lg modal-spring-glass overflow-hidden glass-modal">
                <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b" style={{ borderColor: 'var(--border-secondary)' }}>
                    <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{t('model.title')}</h3>
                    <button
                        onClick={onClose}
                        className="w-8 h-8 flex items-center justify-center rounded-full transition"
                        style={{ color: 'var(--text-tertiary)' }}
                    >
                        <X size={16} />
                    </button>
                </div>

                <div className="px-6 py-5 space-y-5 overflow-y-auto max-h-[70vh]">
                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-lg bg-pink-50 dark:bg-pink-900/30 flex items-center justify-center">
                                <FlaskConical size={14} className="text-pink-500" />
                            </div>
                            <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{t('model.e2.title')}</p>
                        </div>
                        <p className="text-xs leading-relaxed pl-9" style={{ color: 'var(--text-secondary)' }}>{t('model.e2.body')}</p>
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-lg bg-purple-50 dark:bg-purple-900/30 flex items-center justify-center">
                                <Pill size={14} className="text-purple-500" />
                            </div>
                            <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{t('model.cpa.title')}</p>
                        </div>
                        <p className="text-xs leading-relaxed pl-9" style={{ color: 'var(--text-secondary)' }}>{t('model.cpa.body')}</p>
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-lg bg-amber-50 dark:bg-amber-900/30 flex items-center justify-center">
                                <Pill size={14} className="text-amber-500" />
                            </div>
                            <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{t('model.bica.title')}</p>
                        </div>
                        <p className="text-xs leading-relaxed pl-9" style={{ color: 'var(--text-secondary)' }}>{t('model.bica.body')}</p>
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-lg bg-sky-50 dark:bg-sky-900/30 flex items-center justify-center">
                                <Pill size={14} className="text-sky-500" />
                            </div>
                            <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{t('model.spl.title')}</p>
                        </div>
                        <p className="text-xs leading-relaxed pl-9" style={{ color: 'var(--text-secondary)' }}>{t('model.spl.body')}</p>
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-lg bg-teal-50 dark:bg-teal-900/30 flex items-center justify-center">
                                <Pill size={14} className="text-teal-500" />
                            </div>
                            <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{t('model.testosterone.title')}</p>
                        </div>
                        <p className="text-xs leading-relaxed pl-9" style={{ color: 'var(--text-secondary)' }}>{t('model.testosterone.body')}</p>
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-lg bg-blue-50 dark:bg-blue-900/30 flex items-center justify-center">
                                <BrainCircuit size={14} className="text-blue-500" />
                            </div>
                            <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{t('model.ekf.title')}</p>
                        </div>
                        <p className="text-xs leading-relaxed pl-9" style={{ color: 'var(--text-secondary)' }}>{t('model.ekf.body')}</p>
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-lg bg-rose-50 dark:bg-rose-900/30 flex items-center justify-center">
                                <TrendingUp size={14} className="text-rose-500" />
                            </div>
                            <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{t('model.ou.title')}</p>
                        </div>
                        <p className="text-xs leading-relaxed pl-9" style={{ color: 'var(--text-secondary)' }}>{t('model.ou.body')}</p>
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-lg bg-teal-50 dark:bg-teal-900/30 flex items-center justify-center">
                                <Sparkles size={14} className="text-teal-500" />
                            </div>
                            <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{t('model.mipd.title')}</p>
                        </div>
                        <p className="text-xs leading-relaxed pl-9" style={{ color: 'var(--text-secondary)' }}>{t('model.mipd.body')}</p>
                    </div>
                </div>

                <div className="px-6 pb-6 pt-4">
                    <button
                        onClick={onClose}
                        className="w-full py-3 text-white text-sm font-bold rounded-xl btn-press-glass transition glass-btn-primary"
                    >
                        {t('btn.ok')}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ModelInfoModal;
