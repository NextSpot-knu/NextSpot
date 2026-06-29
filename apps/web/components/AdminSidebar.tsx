'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LayoutDashboard, Building2, BarChart3, Settings, HelpCircle, Sparkles, LogOut } from 'lucide-react';
import { signOutAdmin } from '@/lib/admin-auth';

export function AdminSidebar() {
  const pathname = usePathname();
  const router = useRouter();

  const handleLogout = () => {
    signOutAdmin();
    router.replace('/admin/login');
  };

  const menuItems = [
    { name: 'Dashboard', path: '/admin/dashboard', icon: LayoutDashboard },
    { name: '인프라 관리', path: '/admin/infrastructure', icon: Building2 },
    { name: 'Simulator', path: '/admin/simulator', icon: Sparkles },
    { name: '통계 리포트', path: '/admin/reports', icon: BarChart3 },
    { name: '문의 관리 (Support)', path: '/admin/support', icon: HelpCircle },
    { name: '시스템 설정', path: '/admin/settings', icon: Settings },
  ];

  return (
    <aside className="w-64 bg-slate-900 border-r border-slate-800 flex flex-col flex-shrink-0 h-screen overflow-y-auto">
      <div className="p-6 border-b border-slate-800 sticky top-0 bg-slate-900 z-10">
        <h1 className="text-2xl font-black text-blue-400 tracking-tight">
          InduSpot<span className="text-slate-500 font-medium text-sm ml-2">B2B Admin</span>
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
                  ? 'bg-blue-500/10 text-blue-300'
                  : 'text-slate-300 hover:bg-slate-800 font-medium'
              }`}
            >
              <Icon size={20} />
              {item.name}
            </Link>
          );
        })}
      </nav>

      {/* 로그아웃 */}
      <div className="p-4 border-t border-slate-800 sticky bottom-0 bg-slate-900">
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-xl font-medium text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition-colors"
        >
          <LogOut size={20} />
          로그아웃
        </button>
      </div>
    </aside>
  );
}
