'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Lock, ShieldCheck, Loader2, Eye, EyeOff } from 'lucide-react';
import { signInWithPassword } from '@/lib/admin-auth';

// 관리자 진입 = 데모용 간편 인증. 비밀번호 한 개(`admin`)만 입력하면 진입.
// 성공 시 로컬 세션 마커가 저장되고, admin/layout 가드가 통과시킨다.
export default function AdminLoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) {
      setError('비밀번호를 입력해주세요.');
      return;
    }

    setIsLoading(true);
    setError('');

    if (signInWithPassword(password)) {
      router.replace('/admin/dashboard');
    } else {
      setError('비밀번호가 올바르지 않습니다.');
      setIsLoading(false);
    }
  };

  if (!isMounted) {
    return null;
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-[#070b19] font-sans relative overflow-hidden">
      {/* Background ambient glow effect */}
      <div className="absolute top-1/4 left-1/4 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-blue-600/10 blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 translate-x-1/2 translate-y-1/2 w-96 h-96 bg-indigo-600/10 blur-[120px] rounded-full pointer-events-none" />

      {/* Grid Pattern Overlay */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#1e293b_1px,transparent_1px),linear-gradient(to_bottom,#1e293b_1px,transparent_1px)] bg-[size:4rem_4rem] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_50%,#000_70%,transparent_100%)] opacity-[0.15] pointer-events-none" />

      <div className="w-full max-w-md px-6 z-10 animate-slide-up">
        {/* Card */}
        <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl p-8 md:p-10 relative overflow-hidden">
          {/* Subtle top light bar */}
          <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-blue-500 to-transparent opacity-80" />

          {/* Logo / Title Section */}
          <div className="text-center mb-8">
            <div className="inline-flex p-3 bg-blue-500/10 border border-blue-500/20 text-blue-400 rounded-xl mb-4 shadow-[0_0_15px_rgba(59,130,246,0.1)]">
              <ShieldCheck size={28} className="animate-pulse" />
            </div>
            <h1 className="text-2xl font-black text-white tracking-tight">
              NextSpot <span className="text-blue-500 text-base font-semibold">관광 관제</span>
            </h1>
            <p className="text-slate-400 text-sm mt-2">
              경주 관광 혼잡 관리를 위한 관리자 인증
            </p>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Password */}
            <div>
              <label
                htmlFor="password"
                className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2"
              >
                비밀번호
              </label>
              <div className="relative">
                <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center text-slate-500">
                  <Lock size={18} />
                </span>
                <input
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  disabled={isLoading}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="관리자 비밀번호 입력"
                  className="w-full pl-10 pr-10 py-3 bg-slate-950/80 border border-slate-800 rounded-xl text-white placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/80 transition-all text-sm disabled:opacity-50"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-slate-500 hover:text-slate-300 transition-colors"
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            {/* Error Message */}
            {error && (
              <div className="p-3.5 bg-red-950/40 border border-red-900/60 rounded-xl text-red-200 text-xs font-medium flex items-center gap-2 animate-fade-in">
                <span className="w-1.5 h-1.5 bg-red-500 rounded-full flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {/* Submit Button */}
            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-3.5 px-4 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white rounded-xl font-semibold text-sm shadow-[0_4px_12px_rgba(59,130,246,0.25)] hover:shadow-[0_4px_20px_rgba(59,130,246,0.4)] hover:-translate-y-[1px] transition-all disabled:opacity-50 disabled:pointer-events-none flex items-center justify-center gap-2"
            >
              {isLoading ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  인증 처리 중...
                </>
              ) : (
                '관리자 인증'
              )}
            </button>
          </form>

          {/* Footer note */}
          <div className="mt-8 text-center">
            <span className="text-slate-500 text-xs">
              관리자 전용 · 무단 접근이 엄격히 제한됩니다.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
