'use client';

// 공모전 심사용 계정 안내 — 어느 콘솔에 어느 계정으로 들어가는지 한눈에 보여준다.
//
// 계정이 둘이라(사장님·관제) 안내가 뭉뚱그려지면 심사위원이 반대 계정으로 로그인해
// '권한 없음'에서 멈춘다. 그래서 관문 화면은 그 콘솔 계정 **하나만**(`only`) 보여주고,
// 목적지가 정해지지 않은 자리(`?next=` 없이 연 공용 로그인)에서만 둘 다 보여준다.
//
// 비밀번호는 표시하지 않는다 — lib/judgeAccounts.ts 머리말 참조.

import { JUDGE_ACCOUNTS, type JudgeConsole } from '@/lib/judgeAccounts';
import { useT } from '@/lib/i18n/I18nProvider';

const TONE = {
  // 관광객 화면(한지 라이트)
  tourist: {
    box: 'border-gold/30 bg-gold/10',
    title: 'text-gold-deep',
    label: 'text-muk-soft',
    email: 'text-muk',
    note: 'text-muk-soft',
    fill: 'border-gold/40 bg-white text-gold-deep hover:bg-hanji-deep focus-visible:ring-gold/60',
  },
  // 관제 화면(한옥 종이 테마)
  console: {
    box: 'border-hanok-line bg-hanok',
    title: 'text-hanok-ink',
    label: 'text-hanok-muted',
    email: 'text-hanok-ink',
    note: 'text-hanok-muted',
    fill: 'border-hanok-line bg-hanok-card text-hanok-ink hover:opacity-80 focus-visible:ring-gold/60',
  },
} as const;

export function JudgeAccountHint({
  only,
  tone = 'tourist',
  onFill,
  className = '',
}: {
  /** 한 콘솔 계정만 보여줄 때. 생략하면 둘 다. */
  only?: JudgeConsole;
  tone?: keyof typeof TONE;
  /** 주면 계정마다 '입력' 버튼이 붙는다(로그인 폼의 이메일 칸 채우기). */
  onFill?: (email: string) => void;
  className?: string;
}) {
  const t = useT();
  const c = TONE[tone];
  const rows: { console: JudgeConsole; label: string }[] = [
    { console: 'merchant', label: t('judgeAccount.merchant') },
    { console: 'admin', label: t('judgeAccount.admin') },
  ];

  return (
    <section
      aria-label={t('judgeAccount.title')}
      className={`rounded-2xl border px-4 py-3 text-left ${c.box} ${className}`}
    >
      <p className={`text-[13px] font-bold ${c.title}`}>{t('judgeAccount.title')}</p>
      <dl className="mt-1.5 flex flex-col gap-2">
        {rows
          .filter((row) => !only || row.console === only)
          .map((row) => {
            const email = JUDGE_ACCOUNTS[row.console];
            return (
              // 라벨 위·주소 아래 두 줄 — 라벨 길이가 로케일마다 달라(ja 9자) 한 줄 고정폭은 넘친다.
              // dl 의 그룹 div 는 dt·dd 만 자식으로 둔다(버튼은 dd 안).
              <div key={row.console} className="flex flex-col gap-0.5">
                <dt className={`text-xs ${c.label}`}>{row.label}</dt>
                <dd className="flex items-center gap-2">
                  <span className={`min-w-0 flex-1 select-all break-all text-sm font-semibold ${c.email}`}>
                    {email}
                  </span>
                  {onFill && (
                    <button
                      type="button"
                      onClick={() => onFill(email)}
                      aria-label={t('judgeAccount.fillAria', { email })}
                      className={`shrink-0 rounded-lg border px-2.5 py-1 text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 ${c.fill}`}
                    >
                      {t('judgeAccount.fill')}
                    </button>
                  )}
                </dd>
              </div>
            );
          })}
      </dl>
      <p className={`mt-1.5 text-xs leading-relaxed ${c.note}`}>{t('judgeAccount.password')}</p>
    </section>
  );
}
