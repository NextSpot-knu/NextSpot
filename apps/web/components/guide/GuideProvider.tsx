'use client';

import { createContext, useContext, useRef, useState, useEffect, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { CircleHelp, X } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useT } from '@/lib/i18n/I18nProvider';

// Keep the story, illustrations and their CSS out of the map's initial bundle.
const GuideContent = dynamic(() => import('./GuideContent'));
const GuideContext = createContext<((trigger: HTMLButtonElement) => void) | null>(null);

export function GuideButton({ className = '', compact = false }: { className?: string; compact?: boolean }) {
  const open = useContext(GuideContext);
  const t = useT();
  return (
    <button type="button" aria-haspopup="dialog" aria-label={t('guide.title')}
      onClick={(event) => { event.stopPropagation(); open?.(event.currentTarget); }}
      className={`inline-flex items-center justify-center gap-2 rounded-xl text-muk-soft hover:text-muk hover:bg-gold/10 focus-visible:outline-2 focus-visible:outline-gold-deep ${className}`}>
      <CircleHelp size={compact ? 20 : 25} aria-hidden />
      <span className={compact ? 'text-xs font-medium' : 'text-[10px] font-medium'}>{t('guide.label')}</span>
    </button>
  );
}

export default function GuideProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const pathname = usePathname();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [openedPath, setOpenedPath] = useState<string | null>(null);
  const opened = openedPath !== null && openedPath === pathname;

  const close = () => {
    dialogRef.current?.close();
    setOpenedPath(null);
  };

  useEffect(() => {
    if (!opened) return;
    const dialog = dialogRef.current;
    const previousOverflow = document.body.style.overflow;
    dialog?.showModal();
    closeRef.current?.focus();
    document.body.style.overflow = 'hidden';
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
      if (triggerRef.current?.isConnected) triggerRef.current.focus();
    };
  }, [opened]);

  return (
    <GuideContext.Provider value={(trigger) => {
      triggerRef.current = trigger;
      setOpenedPath(pathname);
    }}>
      {children}
      <dialog ref={dialogRef} aria-label={t('guide.title')}
        onCancel={close} onClose={() => setOpenedPath(null)}
        className="fixed inset-0 m-auto h-[100dvh] max-h-[100dvh] w-screen max-w-none overflow-y-auto overscroll-contain border-0 bg-hanji p-0 text-muk backdrop:bg-hanok/65 md:h-[92dvh] md:max-w-[1180px] md:rounded-[28px] md:shadow-2xl">
        <div className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-hanji/95 px-5 py-3 backdrop-blur-xl">
          <span className="text-sm font-semibold">NextSpot <span className="ml-2 font-normal text-muk-soft">{t('guide.label')}</span></span>
          <button ref={closeRef} type="button" onClick={close} aria-label={t('guide.close')}
            className="flex h-11 w-11 items-center justify-center rounded-full border border-line hover:bg-hanji-deep focus-visible:outline-2 focus-visible:outline-gold-deep"><X size={20} /></button>
        </div>
        {opened && <GuideContent onNavigate={close} />}
      </dialog>
    </GuideContext.Provider>
  );
}
