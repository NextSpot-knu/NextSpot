'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LayoutDashboard, Building2, BarChart3, Settings, HelpCircle, Sparkles, LogOut, ShieldAlert, Printer, UserCog, Compass } from 'lucide-react';
import { signOutAdmin } from '@/lib/admin-auth';
import { useAccount, canEnterDevConsole } from '@/lib/account';

export function AdminSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { account } = useAccount();

  const handleLogout = () => {
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
    { name: '문의 관리 (Support)', path: '/admin/support', icon: HelpCircle },
    { name: '시스템 설정', path: '/admin/settings', icon: Settings },
    // 개발자 콘솔은 팀 전용이라 developer 에게만 보인다 — 관제 화면(정부기관 관계자)에는
    // 역할 임명 같은 운영 도구를 노출하지 않는다.
    ...(canEnterDevConsole(account)
      ? [{ name: '개발자 콘솔', path: '/dev', icon: UserCog }]
      : []),
  ];

  return (
    <aside className="w-64 bg-hanok-panel border-r border-hanok-line flex flex-col flex-shrink-0 h-screen overflow-y-auto">
      <div className="p-6 border-b border-hanok-line sticky top-0 bg-hanok-panel z-10">
        <h1 className="text-2xl font-black font-serif text-gold tracking-tight">
          NextSpot<span className="text-hanok-muted font-medium text-sm ml-2">관광 관제</span>
        </h1>
      </div>
      <nav className="flex-1 p-4 flex flex-col gap-2">
        {menuItems.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.path;
          return (
            <Link
              key={item.path}
              href={item.path}
              className={`flex items-center gap-3 px-4 py-3 rounded-xl font-semibold transition-colors ${
                isActive
                  ? 'bg-gold/10 text-gold'
                  : 'text-hanok-muted hover:bg-hanok-card font-medium'
              }`}
            >
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
