'use client';

// 사장님 콘솔(머천트) 입구 — ① 비밀번호 게이트 → ② 내 가게(시설) 선택.
// admin/login 패턴을 미러하되, 관광객 쪽과 같은 한지(라이트) 팔레트를 쓴다(관제 대시보드의
// 한옥 다크 팔레트와는 의도적으로 다른 톤 — 사장님 콘솔은 사업자용이지 관제용이 아니다).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Store, Lock, Eye, EyeOff, Loader2, ChevronRight, RefreshCw, BadgePercent } from 'lucide-react';
import { createPublicClient } from '@/lib/supabase';
import {
  signInWithMerchantPassword,
  isMerchantAuthed,
  getMerchantFacility,
  saveMerchantFacility,
  type MerchantFacility,
} from './_lib/merchant-auth';

interface FacilityRow {
  id: string;
  name: string;
  type: string;
  coupon_rate: number | null;
}

const TYPE_LABEL: Record<string, string> = {
  restaurant: '음식점',
  cafe: '카페',
  attraction: '관광지',
  culture: '문화시설',
};

export default function MerchantGatePage() {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [facility, setFacility] = useState<MerchantFacility | null>(null);
  const [showPicker, setShowPicker] = useState(false);

  // --- 게이트(비밀번호) ---
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [gateError, setGateError] = useState('');

  // --- 시설 선택 ---
  const [facilities, setFacilities] = useState<FacilityRow[] | null>(null);
  const [facilitiesError, setFacilitiesError] = useState('');
  const [loadingFacilities, setLoadingFacilities] = useState(false);
  const [selectedId, setSelectedId] = useState<string>('');

  useEffect(() => {
    setMounted(true);
    setAuthed(isMerchantAuthed());
    setFacility(getMerchantFacility());
  }, []);

  const loadFacilities = useCallback(async () => {
    setLoadingFacilities(true);
    setFacilitiesError('');
    try {
      const supabase = createPublicClient();
      const { data, error } = await supabase
        .from('facilities')
        .select('id, name, type, coupon_rate')
        .order('coupon_rate', { ascending: false })
        .order('name', { ascending: true });
      if (error) throw error;
      setFacilities((data as FacilityRow[]) || []);
    } catch {
      // 정직한 폴백 — 무한 스켈레톤 대신 재시도 버튼을 보여준다.
      setFacilitiesError('가게 목록을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.');
      setFacilities(null);
    } finally {
      setLoadingFacilities(false);
    }
  }, []);

  const needsPicker = authed && (showPicker || !facility);

  useEffect(() => {
    if (needsPicker && facilities === null && !loadingFacilities && !facilitiesError) {
      loadFacilities();
    }
  }, [needsPicker, facilities, loadingFacilities, facilitiesError, loadFacilities]);

  const { partnered, others } = useMemo(() => {
    const list = facilities || [];
    return {
      partnered: list.filter((f) => (f.coupon_rate ?? 0) > 0),
      others: list.filter((f) => !((f.coupon_rate ?? 0) > 0)),
    };
  }, [facilities]);

  const handleGateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) {
      setGateError('비밀번호를 입력해주세요.');
      return;
    }
    if (signInWithMerchantPassword(password)) {
      setGateError('');
      setPassword('');
      setAuthed(true);
    } else {
      setGateError('비밀번호가 올바르지 않습니다.');
    }
  };

  const handleConfirmFacility = () => {
    const fac = (facilities || []).find((f) => f.id === selectedId);
    if (!fac) return;
    const payload: MerchantFacility = {
      id: fac.id,
      name: fac.name,
      type: fac.type,
      couponRate: fac.coupon_rate ?? 0,
    };
    saveMerchantFacility(payload);
    setFacility(payload);
    setShowPicker(false);
    router.push('/merchant/dashboard');
  };

  if (!mounted) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-hanji text-muk-soft">
        <Loader2 className="animate-spin" size={20} />
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-hanji flex flex-col items-center justify-center px-5 py-10 font-sans">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-gold/15 border border-gold/30 flex items-center justify-center text-gold-deep mb-4">
            <Store size={26} />
          </div>
          <h1 className="text-2xl font-bold font-serif text-muk tracking-tight">내 가게 대시보드</h1>
          <p className="text-sm text-muk-soft mt-1">NextSpot 사장님 콘솔</p>
        </div>

        {!authed ? (
          <div className="bg-white border border-line rounded-3xl p-6 shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
            <form onSubmit={handleGateSubmit} className="space-y-4">
              <div>
                <label htmlFor="merchant-password" className="block text-xs font-semibold text-muk-soft mb-2">
                  사장님 비밀번호
                </label>
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center text-muk-soft">
                    <Lock size={18} />
                  </span>
                  <input
                    id="merchant-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    autoFocus
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="비밀번호 입력"
                    className="w-full pl-10 pr-10 py-3 bg-hanji border border-line rounded-xl text-muk placeholder-muk-soft/70 focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold/70 transition-all text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-muk-soft"
                  >
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              {gateError && (
                <div className="p-3 bg-terracotta/10 border border-terracotta/30 rounded-xl text-terracotta text-xs font-medium">
                  {gateError}
                </div>
              )}

              <button
                type="submit"
                className="w-full py-3.5 rounded-xl font-semibold text-sm text-white bg-gradient-to-r from-gold to-terracotta hover:opacity-90 transition-opacity"
              >
                입장하기
              </button>
            </form>

            <p className="mt-5 text-center text-[11px] text-muk-soft leading-relaxed">
              데모 게이트 — 실서비스는 사업자 인증 연동 예정입니다.
              <br />
              가맹점 사장님 전용 · 비밀번호는 담당자에게 문의해주세요.
            </p>
          </div>
        ) : !needsPicker && facility ? (
          <div className="bg-white border border-line rounded-3xl p-6 shadow-[0_2px_14px_rgba(43,35,32,0.06)] flex flex-col gap-4">
            <div>
              <p className="text-xs font-semibold text-muk-soft mb-1">최근 선택한 가게</p>
              <p className="text-lg font-bold font-serif text-muk">{facility.name}</p>
              <p className="text-xs text-muk-soft mt-0.5">{TYPE_LABEL[facility.type] || facility.type}</p>
            </div>
            <button
              onClick={() => router.push('/merchant/dashboard')}
              className="w-full py-3.5 rounded-xl font-semibold text-sm text-white bg-gradient-to-r from-gold to-terracotta hover:opacity-90 transition-opacity flex items-center justify-center gap-2"
            >
              대시보드로 이동 <ChevronRight size={16} />
            </button>
            <button
              onClick={() => setShowPicker(true)}
              className="w-full py-3 rounded-xl font-medium text-sm text-muk-soft border border-line hover:bg-hanji transition-colors"
            >
              다른 가게 선택
            </button>
          </div>
        ) : (
          <div className="bg-white border border-line rounded-3xl p-6 shadow-[0_2px_14px_rgba(43,35,32,0.06)]">
            <p className="text-sm font-semibold text-muk mb-4">운영 중인 가게를 선택해주세요</p>

            {loadingFacilities && (
              <div className="flex items-center justify-center gap-2 py-10 text-muk-soft text-sm">
                <Loader2 size={18} className="animate-spin" /> 가게 목록을 불러오는 중…
              </div>
            )}

            {!loadingFacilities && facilitiesError && (
              <div className="flex flex-col items-center gap-3 py-8">
                <p className="text-sm text-terracotta text-center">{facilitiesError}</p>
                <button
                  onClick={loadFacilities}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg border border-line text-muk text-sm hover:bg-hanji transition-colors"
                >
                  <RefreshCw size={14} /> 다시 시도
                </button>
              </div>
            )}

            {!loadingFacilities && !facilitiesError && facilities && (
              <div className="space-y-4">
                {partnered.length > 0 && (
                  <div>
                    <p className="text-[11px] font-bold text-gold-deep mb-2 flex items-center gap-1">
                      <BadgePercent size={13} /> 제휴 가맹점
                    </p>
                    <div className="flex flex-col gap-2">
                      {partnered.map((f) => (
                        <FacilityOption key={f.id} f={f} selected={selectedId === f.id} onSelect={() => setSelectedId(f.id)} />
                      ))}
                    </div>
                  </div>
                )}
                {others.length > 0 && (
                  <div>
                    <p className="text-[11px] font-bold text-muk-soft mb-2">전체 시설</p>
                    <div className="flex flex-col gap-2 max-h-64 overflow-y-auto pr-1">
                      {others.map((f) => (
                        <FacilityOption key={f.id} f={f} selected={selectedId === f.id} onSelect={() => setSelectedId(f.id)} />
                      ))}
                    </div>
                  </div>
                )}
                {facilities.length === 0 && (
                  <p className="text-sm text-muk-soft text-center py-6">등록된 시설이 없습니다.</p>
                )}

                <button
                  disabled={!selectedId}
                  onClick={handleConfirmFacility}
                  className="w-full py-3.5 rounded-xl font-semibold text-sm text-white bg-gradient-to-r from-gold to-terracotta hover:opacity-90 transition-opacity disabled:opacity-40 disabled:pointer-events-none mt-2"
                >
                  이 가게로 시작하기
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function FacilityOption({
  f,
  selected,
  onSelect,
}: {
  f: FacilityRow;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-4 py-3 rounded-xl border transition-colors flex items-center justify-between gap-2 ${
        selected ? 'border-gold bg-gold/10' : 'border-line hover:bg-hanji'
      }`}
    >
      <span>
        <span className="block text-sm font-semibold text-muk">{f.name}</span>
        <span className="block text-[11px] text-muk-soft">{TYPE_LABEL[f.type] || f.type}</span>
      </span>
      {(f.coupon_rate ?? 0) > 0 && (
        <span className="flex-shrink-0 px-2 py-0.5 rounded-full text-[10px] font-bold bg-gold/15 text-gold-deep border border-gold/30">
          {Math.round((f.coupon_rate ?? 0) * 100)}%
        </span>
      )}
    </button>
  );
}
