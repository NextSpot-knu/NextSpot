'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LayoutDashboard, Building2, BarChart3, Settings, HelpCircle, Sparkles, LogOut, ShieldAlert, Printer, UserCog, Compass, FlaskConical } from 'lucide-react';
import { signOutAdmin } from '@/lib/adminAuth';
import { useAccount, canEnterDevConsole } from '@/lib/account';
import { useDemoToast } from '@/components/DemoBadge';

// demo=true 는 `/admin/dashboard?demo=1`(로그인 없는 읽기 전용 데모) 전용이다. 메뉴는 그대로
// 보이되 **어디로도 이동하지 않는다** — 데모에는 세션이 없어서 다른 관제 화면은 전부 로그인
// 게이트로 튕기고, 심사위원에게는 그게 '고장' 으로 읽힌다. 로그아웃도 진짜 세션을 버리므로 막는다.
export function AdminSidebar({ demo = false }: { demo?: boolean } = {}) {
  const pathname = usePathname();
  const router = useRouter();
  const { account } = useAccount();
  const demoToast = useDemoToast();

  const handleLogout = () => {
    if (demo) {
      demoToast();
      return;
    }
    // 세션 폐기를 기다리지 않고 즉시 화면을 옮긴다(실패해도 로그인으로 보내는 게 맞다).
    void signOutAdmin();
    router.replace('/admin/login');
  };

  const menuItems = [
    { name: 'Dashboard', path: '/admin/dashboard', icon: LayoutDashboard },
    { name: '장소 관리', path: '/admin/infrastructure', icon: Building2 },
    { name: 'Simulator', path: '/admin/simulator', icon: Sparkles },
    { name: '통계 리포트', path: '/admin/reports', icon: BarChart3 },
    { name: '안전 경보', path: '/admin/safety', icon: ShieldAlert },
    { name: '성과 리포트', path: '/admin/report', icon: Printer },
    // 혼잡 추정기를 서울 실측과 대조한 성적표(CONGESTION_ENGINE_PLAN §5.4 A). 표본이 없어도 들어가서
    // '수집 시작 전' 을 확인할 수 있어야 하므로 조건 없이 보인다.
    { name: '엔진 검증', path: '/admin/engine-validation', icon: FlaskConical },
    { name: '문의 관리 (Support)', path: '/admin/support', icon: HelpCircle },
    { name: '시스템 설정', path: '/admin/settings', icon: Settings },
    // 개발자 콘솔은 팀 전용이라 developer 에게만 보인다 — 관제 화면(정부기관 관계자)에는
    // 역할 임명 같은 운영 도구를 노출하지 않는다.
    // 프로덕션에서는 역할과 무관하게 감춘다(벨트+멜빵): 심사 계정에 developer 가 잘못 붙어도
    // 관제 사이드바에 내부 도구 링크가 뜨지 않는다.
    ...(canEnterDevConsole(account) && process.env.NODE_ENV !== 'production'
      ? [{ name: '개발자 콘솔', path: '/dev', icon: UserCog }]
      : []),
  ];

  return (
    <aside className="w-64 bg-hanok-panel border-r border-hanok-line flex flex-col flex-shrink-0 h-screen overflow-y-auto">
      <div className="p-6 border-b border-hanok-line sticky top-0 bg-hanok-panel z-10">
        {/* 라이트 종이 테마 전환 후 워드마크(네이비/코랄, 라이트 배경용)를 그대로 쓴다. */}
        <div className="flex items-end gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- 정적 export, public 자산 직접 참조 */}
          <img src="/nextspot-logo.png" alt="NextSpot" className="h-7 w-auto" />
          <span className="text-hanok-muted font-semibold text-sm leading-none pb-0.5">관광 관제</span>
        </div>
      </div>
      <nav className="flex-1 p-4 flex flex-col gap-2">
        {menuItems.map((item) => {
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
            <Link key={item.path} href={item.path} className={className}>
              <Icon size={20} />
              {item.name}
            </Link>
          );
        })}
      </nav>

      {/* 나가기 · 로그아웃 — 둘은 다르다.
          '관광객 앱으로'는 **세션을 유지한 채** 화면만 옮긴다(관제 담당자가 실제 앱을
          확인하러 가는 동선). 로그아웃은 세션을 버린다. 나가기가 없어서 관제에 들어오면
          주소를 직접 쳐야 앱으로 돌아갈 수 있었다. */}
      <div className="p-4 border-t border-hanok-line sticky bottom-0 bg-hanok-panel flex flex-col gap-1">
        <Link
          href="/main"
          className="w-full flex items-center gap-3 px-4 py-3 rounded-xl font-medium text-hanok-muted hover:bg-hanok-card hover:text-hanok-ink transition-colors"
        >
          <Compass size={20} />
          관광객 앱으로
        </Link>
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-xl font-medium text-hanok-muted hover:bg-hanok-card hover:text-hanok-ink transition-colors"
        >
          <LogOut size={20} />
          로그아웃
        </button>
      </div>
    </aside>
  );
}
