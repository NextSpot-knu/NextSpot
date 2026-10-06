'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LayoutDashboard, Building2, BarChart3, Settings, HelpCircle, Sparkles, LogIn, LogOut, ShieldAlert, Printer, UserCog, Compass, FlaskConical, Menu, X } from 'lucide-react';
import { signOutAdmin } from '@/lib/adminAuth';
import { useAccount, canEnterDevConsole } from '@/lib/account';
import { useDemoToast } from '@/components/DemoBadge';
import { useT } from '@/lib/i18n/I18nProvider';

// 심사 기간에는 메뉴에서 감추는 화면(PM 결정 4.14). '엔진 검증' 은 서울 데이터로 엔진을 대 보는 화면이라
// 경주 관제의 메뉴에 서 있으면 첫인상이 서울이 된다. 화면 자체는 /admin/engine-validation 으로 그대로
// 열린다(질의응답용 · 대시보드 맨 아래 링크). 심사가 끝나면 이 집합에서 빼기만 하면 메뉴로 돌아온다.
const HIDDEN_FROM_MENU = new Set<string>(['/admin/engine-validation']);

// demo=true 는 `/admin/dashboard?demo=1`(로그인 없는 읽기 전용 데모) 전용이다. 메뉴는 그대로
// 보이되 **어디로도 이동하지 않는다** — 데모에는 세션이 없어서 다른 관제 화면은 전부 로그인
// 게이트로 튕기고, 심사위원에게는 그게 '고장' 으로 읽힌다.
// 대신 데모에는 버릴 세션이 없으므로 로그아웃 자리에 **로그인 게이트로 가는 길**을 둔다 —
// 데모로 들어온 사람이 실제 계정으로 넘어갈 문이 없으면 이 화면은 일방통행이 된다.
export function AdminSidebar({ demo = false }: { demo?: boolean } = {}) {
  const pathname = usePathname();
  const router = useRouter();
  const t = useT();
  const { account } = useAccount();
  const demoToast = useDemoToast();

  const handleLogout = () => {
    // 세션 폐기를 기다리지 않고 즉시 화면을 옮긴다(실패해도 로그인으로 보내는 게 맞다).
    void signOutAdmin();
    router.replace('/admin/login');
  };

  const menuItems = [
    { name: '관제 대시보드', path: '/admin/dashboard', icon: LayoutDashboard },
    { name: '장소 관리', path: '/admin/infrastructure', icon: Building2 },
    { name: 'SPOT 시뮬레이터', path: '/admin/simulator', icon: Sparkles },
    { name: '통계 리포트', path: '/admin/reports', icon: BarChart3 },
    { name: '안전 경보', path: '/admin/safety', icon: ShieldAlert },
    { name: '성과 리포트', path: '/admin/report', icon: Printer },
    // 혼잡 추정기를 서울 실측과 대조한 성적표(CONGESTION_ENGINE_PLAN §5.4 A). 표본이 없어도 들어가서
    // '수집 시작 전' 을 확인할 수 있어야 하므로 조건 없이 보인다(심사 기간에만 위 HIDDEN_FROM_MENU 가 감춘다).
    { name: '엔진 검증', path: '/admin/engine-validation', icon: FlaskConical },
    { name: '문의 관리', path: '/admin/support', icon: HelpCircle },
    { name: '시스템 설정', path: '/admin/settings', icon: Settings },
    // 개발자 콘솔은 팀 전용이라 developer 에게만 보인다 — 관제 화면(정부기관 관계자)에는
    // 역할 임명 같은 운영 도구를 노출하지 않는다.
    // 프로덕션에서는 역할과 무관하게 감춘다(벨트+멜빵): 심사 계정에 developer 가 잘못 붙어도
    // 관제 사이드바에 내부 도구 링크가 뜨지 않는다.
    ...(canEnterDevConsole(account) && process.env.NODE_ENV !== 'production'
      ? [{ name: '개발자 콘솔', path: '/dev', icon: UserCog }]
      : []),
  ].filter((item) => !HIDDEN_FROM_MENU.has(item.path));

  // 휴대폰 폭(lg 미만)에서 여는 메뉴 서랍. 경로가 바뀌면 닫는다(서랍 안 링크로 이동한 경우).
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  const brand = (
    <div className="flex items-end gap-2">
      {/* eslint-disable-next-line @next/next/no-img-element -- 정적 export, public 자산 직접 참조 */}
      <img src="/nextspot-logo.png" alt="NextSpot" className="h-7 w-auto" />
      <span className="text-hanok-muted font-semibold text-sm leading-none pb-0.5">관광 관제</span>
    </div>
  );

  const navItems = menuItems.map((item) => {
    const Icon = item.icon;
    // 데모에서는 대시보드가 '현재 화면' 이고 나머지는 열 수 없다(이동 대신 토스트).
    const isActive = demo ? item.path === '/admin/dashboard' : pathname === item.path;
    const className = `flex items-center gap-3 px-4 py-3 rounded-xl font-semibold transition-colors ${
      isActive
        ? 'bg-gold/10 text-gold-deep'
        : 'text-hanok-muted hover:bg-hanok-card font-medium'
    }`;
    if (demo) {
      return (
        <button key={item.path} type="button" onClick={demoToast} className={`${className} w-full text-left`}>
          <Icon size={20} />
          {item.name}
        </button>
      );
    }
    return (
      <Link key={item.path} href={item.path} className={className} aria-current={isActive ? 'page' : undefined}>
        <Icon size={20} />
        {item.name}
      </Link>
    );
  });

  const exits = (
    <>
      <Link
        href="/main"
        className="w-full flex items-center gap-3 px-4 py-3 rounded-xl font-medium text-hanok-muted hover:bg-hanok-card hover:text-hanok-ink transition-colors"
      >
        <Compass size={20} />
        관광객 앱으로
      </Link>
      {demo ? (
        // 데모에는 버릴 세션이 없다 — 로그아웃 대신 로그인 게이트로 보낸다(심사 계정 안내가 거기 있다).
        <Link
          href="/admin/login"
          className="w-full flex items-center gap-3 px-4 py-3 rounded-xl font-medium text-hanok-muted hover:bg-hanok-card hover:text-hanok-ink transition-colors"
        >
          <LogIn size={20} />
          {t('demo.realLogin')}
        </Link>
      ) : (
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-xl font-medium text-hanok-muted hover:bg-hanok-card hover:text-hanok-ink transition-colors"
        >
          <LogOut size={20} />
          로그아웃
        </button>
      )}
    </>
  );

  return (
    <>
      {/* 휴대폰 폭(lg 미만): 고정 폭 사이드바 대신 얇은 상단 바 + 메뉴 서랍. 256px 사이드바가 390px 화면의
          3분의 2를 차지해 본문 표가 한 칸 40px 로 짓눌렸다(심사위원이 휴대폰으로 관제 계정을 열 수 있다).
          데모는 자기 헤더에 나가는 길이 있어(DemoDashboard) 이 바를 그리지 않는다. */}
      {!demo && (
        <div className="lg:hidden flex h-14 flex-shrink-0 items-center justify-between border-b border-hanok-line bg-hanok-panel px-4 print:hidden">
          {brand}
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label={t('adminShell.openMenu')}
            aria-expanded={drawerOpen}
            aria-controls="admin-menu-drawer"
            // 아이콘만 두면 '여기에 다른 관제 화면이 있다' 가 읽히지 않는다 — 글자로도 말한다(aria-label 은 '열기' 까지).
            className="-mr-1 flex h-11 items-center gap-1.5 rounded-xl border border-hanok-line bg-hanok-card px-3 text-sm font-bold text-hanok-ink hover:bg-hanok-line/60 transition-colors"
          >
            <Menu size={20} aria-hidden="true" />
            {t('adminShell.menuTitle')}
          </button>
        </div>
      )}
      {!demo && drawerOpen && (
        <div
          id="admin-menu-drawer"
          role="dialog"
          aria-modal="true"
          aria-label={t('adminShell.menuTitle')}
          className="lg:hidden fixed inset-0 z-50 flex print:hidden"
        >
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-hanok-ink/40"
          />
          <div className="relative flex h-full w-72 max-w-[85vw] flex-col overflow-y-auto bg-hanok-panel shadow-xl">
            <div className="flex h-14 flex-shrink-0 items-center justify-between border-b border-hanok-line px-4">
              {brand}
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label={t('adminShell.closeMenu')}
                autoFocus
                className="-mr-2 flex h-11 w-11 items-center justify-center rounded-xl text-hanok-muted hover:bg-hanok-card hover:text-hanok-ink transition-colors"
              >
                <X size={22} />
              </button>
            </div>
            <nav className="flex-1 p-4 flex flex-col gap-1">{navItems}</nav>
            <div className="p-4 border-t border-hanok-line flex flex-col gap-1">{exits}</div>
          </div>
        </div>
      )}

      {/* 데스크톱(lg~)은 기존 사이드바 그대로. */}
      <aside className="w-64 bg-hanok-panel border-r border-hanok-line flex-col flex-shrink-0 h-screen overflow-y-auto hidden lg:flex">
        <div className="p-6 border-b border-hanok-line sticky top-0 bg-hanok-panel z-10">
          {/* 라이트 종이 테마 전환 후 워드마크(네이비/코랄, 라이트 배경용)를 그대로 쓴다. */}
          {brand}
        </div>
        <nav className="flex-1 p-4 flex flex-col gap-2">{navItems}</nav>

        {/* 나가기 · 로그아웃 — 둘은 다르다.
            '관광객 앱으로'는 **세션을 유지한 채** 화면만 옮긴다(관제 담당자가 실제 앱을
            확인하러 가는 동선). 로그아웃은 세션을 버린다. 나가기가 없어서 관제에 들어오면
            주소를 직접 쳐야 앱으로 돌아갈 수 있었다. */}
        <div className="p-4 border-t border-hanok-line sticky bottom-0 bg-hanok-panel flex flex-col gap-1">{exits}</div>
      </aside>
    </>
  );
}
