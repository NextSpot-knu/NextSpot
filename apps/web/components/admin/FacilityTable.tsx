'use client';

import { useState, useEffect } from 'react';
import { Settings, Plus, Edit2, Trash2, X, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { toast } from 'sonner';
import { createPublicClient } from '@/lib/supabase';
import { adminApi } from '@/lib/admin-api';
import { REGION } from '@/lib/region';

// 읽기는 anon(RLS: anon_select_facilities 유지), 쓰기는 관리자 API(FastAPI service_role) 경유 —
// anon 직접 쓰기는 RLS 로 거부되며, 과거엔 0행 갱신이 성공으로 표시되는 무음 실패였다(WS-A-6).
const supabase = createPublicClient();

interface FacilityData {
  id: string;
  name: string;
  type: string;
  capacity: number;
  operating_hours?: Record<string, string>;
}

// 시설 유형 목록(값=DB type, name=한글 라벨). 카테고리 탭·모달 select 가 공유한다.
const CATEGORIES = [
  { id: 'restaurant', name: '음식점' },
  { id: 'cafe', name: '카페' },
  { id: 'attraction', name: '관광지' },
  { id: 'culture', name: '문화시설' },
] as const;

type ModalMode = 'create' | 'edit';

export function FacilityTable() {
  const [facilities, setFacilities] = useState<FacilityData[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCategory, setSelectedCategory] = useState('restaurant');
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  // 단일 모달 폼 상태 — 네이티브 prompt()/confirm()/alert() 연쇄를 대체(B2G 관제 데모 신뢰도).
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<ModalMode>('create');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formType, setFormType] = useState('restaurant');
  const [formCapacity, setFormCapacity] = useState('50'); // 제어 입력이라 문자열로 보관, 저장 시 파싱
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const categories = CATEGORIES;

  const fetchFacilities = async () => {
    try {
      const { data, error } = await supabase
        .from('facilities')
        .select('id, name, type, capacity, operating_hours')
        .order('name', { ascending: true });

      if (error) throw error;
      setFacilities(data || []);
    } catch (err) {
      console.error('Failed to fetch facilities in table:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFacilities();
  }, []);

  // 모달이 열려 있을 때 Esc 로 닫기(저장 중에는 무시). 백드롭 클릭·취소 버튼과 함께 3중 이탈 경로.
  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) setModalOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modalOpen, submitting]);

  const openCreateModal = () => {
    setModalMode('create');
    setEditingId(null);
    setFormName('');
    setFormType(selectedCategory); // 신규 유형 기본값 = 현재 선택된 카테고리 탭(기존 prompt 기본값과 동일)
    setFormCapacity('50');
    setFormError(null);
    setModalOpen(true);
  };

  const openEditModal = (fac: FacilityData) => {
    setModalMode('edit');
    setEditingId(fac.id);
    setFormName(fac.name);
    setFormType(fac.type);
    setFormCapacity(String(fac.capacity));
    setFormError(null);
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    // 간단 검증: 빈 값·수용 인원 범위(백엔드 FacilityCreate/Update 와 동일한 1~100000 정수).
    const trimmedName = formName.trim();
    if (!trimmedName) {
      setFormError('장소명을 입력하세요.');
      return;
    }
    const cap = Number(formCapacity);
    if (!Number.isInteger(cap) || cap < 1 || cap > 100000) {
      setFormError('수용 인원은 1~100000 사이의 정수여야 합니다.');
      return;
    }
    if (modalMode === 'create' && !categories.some(c => c.id === formType)) {
      setFormError('올바른 유형을 선택하세요.');
      return;
    }

    setSubmitting(true);
    setFormError(null);
    try {
      if (modalMode === 'create') {
        // 신규 시설 기본좌표 = 지역 중심점(lib/region.ts). 기존 prompt 흐름과 동일한 페이로드.
        await adminApi.post('/api/v1/admin/facilities', {
          name: trimmedName,
          type: formType,
          capacity: cap,
          latitude: REGION.center.lat,
          longitude: REGION.center.lng,
        });
        toast.success('시설이 성공적으로 등록되었습니다.');
      } else if (editingId) {
        // 수정은 name/capacity 만 전송한다 — 백엔드 FacilityUpdate 는 type 을 받지 않으므로(무음 무시)
        // 모달의 유형 select 는 수정 모드에서 읽기 전용으로만 노출한다(회귀 방지).
        await adminApi.patch(`/api/v1/admin/facilities/${editingId}`, {
          name: trimmedName,
          capacity: cap,
        });
        toast.success('시설 정보가 수정되었습니다.');
      }
      await fetchFacilities();
      setModalOpen(false);
    } catch (err: any) {
      // 실패 시 모달은 열어 둔 채 토스트로 안내(사용자가 값 수정 후 재시도 가능).
      const prefix = modalMode === 'create' ? '시설 등록에 실패했습니다: ' : '시설 정보 수정 실패: ';
      toast.error(prefix + (err?.message || '알 수 없는 오류'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = (id: string, name: string) => {
    // 파괴적 동작이므로 네이티브 confirm() 대신 전역 sonner 토스트의 action/cancel 로 인페이지 확인.
    toast(`'${name}' 시설을 삭제할까요?`, {
      description: '삭제된 시설은 되돌릴 수 없습니다.',
      duration: 8000,
      action: {
        label: '삭제',
        onClick: () => {
          adminApi
            .delete(`/api/v1/admin/facilities/${id}`)
            .then(() => {
              setFacilities(prev => prev.filter(f => f.id !== id));
              toast.success('시설이 삭제되었습니다.');
            })
            .catch((err: any) => {
              console.error('Failed to delete facility:', err);
              toast.error(`시설 삭제 중 오류가 발생했습니다: ${err?.message || '알 수 없는 오류'}`);
            });
        },
      },
      cancel: {
        label: '취소',
        onClick: () => {},
      },
    });
  };

  const getHoursText = (hours?: Record<string, string>) => {
    if (!hours) return '24시간';
    // TourAPI 인제스트 형태 {open: 영업시간, closed: 휴무일} — '24시간' 으로 뭉개지 않고 실데이터 표시.
    if (hours.open) return hours.closed ? `${hours.open} (휴무: ${hours.closed})` : hours.open;
    if (hours.weekday) return hours.weekday;
    if (hours.start && hours.end) return `${hours.start}-${hours.end}`;
    return '24시간';
  };

  // Filtering
  const filteredFacilities = facilities.filter(f => f.type === selectedCategory);

  // Pagination
  const totalItems = filteredFacilities.length;
  const totalPages = Math.ceil(totalItems / itemsPerPage) || 1;
  const startIndex = (currentPage - 1) * itemsPerPage;
  const paginatedFacilities = filteredFacilities.slice(startIndex, startIndex + itemsPerPage);

  return (
    <>
      <div className="bg-hanok-panel rounded-2xl border border-hanok-line shadow-sm overflow-hidden col-span-2">
        <div className="p-6 border-b border-hanok-line flex justify-between items-center bg-hanok-card/30">
          <div className="flex items-center gap-2">
            <Settings className="text-hanok-muted" size={20} />
            <h3 className="text-lg font-bold text-hanok-ink">장소 관리 (CRUD)</h3>
          </div>
          <button
            onClick={openCreateModal}
            className="flex items-center gap-2 bg-gold hover:bg-gold-deep text-white px-4 py-2 rounded-lg text-sm font-bold transition-colors"
          >
            <Plus size={16} /> 신규 장소 등록
          </button>
        </div>

        {/* Category Tabs */}
        <div className="flex gap-2 p-4 border-b border-hanok-line bg-hanok-panel/50">
          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => {
                setSelectedCategory(cat.id);
                setCurrentPage(1);
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                selectedCategory === cat.id
                  ? 'bg-gold/25 border-gold/50 text-gold font-bold shadow-sm'
                  : 'bg-hanok-card/80 border-hanok-line/80 text-hanok-muted hover:bg-hanok-card hover:text-hanok-ink'
              }`}
            >
              {cat.name}
            </button>
          ))}
        </div>

        <div className="overflow-x-auto">
          {loading ? (
            <div className="p-8 text-center text-hanok-muted">데이터 로딩 중...</div>
          ) : (
            <>
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-hanok-panel text-hanok-muted text-sm border-b border-hanok-line">
                    <th className="p-4 font-semibold">시설명</th>
                    <th className="p-4 font-semibold">유형</th>
                    <th className="p-4 font-semibold">수용 인원</th>
                    <th className="p-4 font-semibold">운영 시간</th>
                    <th className="p-4 font-semibold">상태</th>
                    <th className="p-4 font-semibold text-right">관리</th>
                  </tr>
                </thead>
                <tbody className="text-sm">
                  {paginatedFacilities.map((fac) => (
                    <tr key={fac.id} className="border-b border-hanok-line hover:bg-hanok-card transition-colors">
                      <td className="p-4 font-bold text-hanok-ink">{fac.name}</td>
                      <td className="p-4">
                        <span className="px-2 py-1 bg-hanok-card text-hanok-muted rounded-md text-xs font-semibold uppercase">
                          {fac.type === 'restaurant' ? '음식점' : fac.type === 'cafe' ? '카페' : fac.type === 'attraction' ? '관광지' : fac.type === 'culture' ? '문화시설' : fac.type}
                        </span>
                      </td>
                      <td className="p-4 text-hanok-muted">{fac.capacity}명/대</td>
                      <td className="p-4 text-hanok-muted">{getHoursText(fac.operating_hours)}</td>
                      <td className="p-4">
                        <span className="px-2 py-1 bg-emerald-500/15 text-emerald-300 text-xs font-bold rounded-md">활성</span>
                      </td>
                      <td className="p-4 flex justify-end gap-2">
                        <button
                          onClick={() => openEditModal(fac)}
                          className="p-1.5 text-hanok-muted hover:text-gold transition-colors bg-hanok-panel border border-hanok-line rounded-md"
                        >
                          <Edit2 size={16} />
                        </button>
                        <button
                          onClick={() => handleDelete(fac.id, fac.name)}
                          className="p-1.5 text-hanok-muted hover:text-rose-400 transition-colors bg-hanok-panel border border-hanok-line rounded-md"
                        >
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {filteredFacilities.length === 0 && (
                    <tr>
                      <td colSpan={6} className="text-center p-8 text-hanok-muted font-medium">등록된 장소가 없습니다.</td>
                    </tr>
                  )}
                </tbody>
              </table>

              {/* Pagination Controls */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between border-t border-hanok-line p-4 bg-hanok-panel/30">
                  <div className="text-xs text-hanok-muted font-medium">
                    총 {totalItems}개 중 {startIndex + 1}-{Math.min(startIndex + itemsPerPage, totalItems)}개 표시
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setCurrentPage(prev => Math.max(prev - 10, 1))}
                      disabled={currentPage === 1}
                      title="10페이지 이전"
                      className="p-1 rounded border border-hanok-line text-hanok-muted hover:bg-hanok-card disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      <ChevronsLeft size={16} />
                    </button>
                    <button
                      onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                      disabled={currentPage === 1}
                      title="이전 페이지"
                      className="p-1 rounded border border-hanok-line text-hanok-muted hover:bg-hanok-card disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <span className="text-xs text-hanok-muted font-semibold px-2">
                      {currentPage} / {totalPages}
                    </span>
                    <button
                      onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                      disabled={currentPage === totalPages}
                      title="다음 페이지"
                      className="p-1 rounded border border-hanok-line text-hanok-muted hover:bg-hanok-card disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      <ChevronRight size={16} />
                    </button>
                    <button
                      onClick={() => setCurrentPage(prev => Math.min(prev + 10, totalPages))}
                      disabled={currentPage === totalPages}
                      title="10페이지 다음"
                      className="p-1 rounded border border-hanok-line text-hanok-muted hover:bg-hanok-card disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      <ChevronsRight size={16} />
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* 신규 등록/수정 단일 모달 폼 — prompt() 3연속을 대체 */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => { if (!submitting) setModalOpen(false); }} // 백드롭 클릭으로 닫기(저장 중 제외)
        >
          <div
            className="w-full max-w-md bg-hanok-panel border border-hanok-line rounded-2xl shadow-xl"
            onClick={(e) => e.stopPropagation()} // 카드 내부 클릭은 닫기로 전파되지 않게
          >
            <div className="flex items-center justify-between p-5 border-b border-hanok-line">
              <h4 className="text-base font-bold text-hanok-ink">
                {modalMode === 'create' ? '신규 장소 등록' : '장소 정보 수정'}
              </h4>
              <button
                onClick={() => setModalOpen(false)}
                disabled={submitting}
                className="p-1 text-hanok-muted hover:text-hanok-ink transition-colors disabled:opacity-50"
                aria-label="닫기"
              >
                <X size={18} />
              </button>
            </div>

            <form
              onSubmit={(e) => { e.preventDefault(); handleSubmit(); }}
              className="p-5 space-y-4"
            >
              {/* 장소명 */}
              <div>
                <label className="block text-xs font-semibold text-hanok-muted mb-1.5">장소명</label>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="예: 황리단길 카페"
                  autoFocus
                  className="w-full px-3 py-2 bg-hanok-card border border-hanok-line rounded-lg text-sm text-hanok-ink placeholder-hanok-muted focus:outline-none focus:border-gold/60"
                />
              </div>

              {/* 유형 — 수정 모드에서는 백엔드가 type 변경을 지원하지 않아 읽기 전용으로 노출 */}
              <div>
                <label className="block text-xs font-semibold text-hanok-muted mb-1.5">유형</label>
                <select
                  value={formType}
                  onChange={(e) => setFormType(e.target.value)}
                  disabled={modalMode === 'edit'}
                  className="w-full px-3 py-2 bg-hanok-card border border-hanok-line rounded-lg text-sm text-hanok-ink focus:outline-none focus:border-gold/60 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {categories.map((cat) => (
                    <option key={cat.id} value={cat.id}>{cat.name}</option>
                  ))}
                </select>
                {modalMode === 'edit' && (
                  <p className="mt-1 text-[11px] text-hanok-muted">유형은 등록 후 이 화면에서 변경할 수 없습니다.</p>
                )}
              </div>

              {/* 수용 인원 */}
              <div>
                <label className="block text-xs font-semibold text-hanok-muted mb-1.5">수용 인원(명/대)</label>
                <input
                  type="number"
                  min={1}
                  max={100000}
                  value={formCapacity}
                  onChange={(e) => setFormCapacity(e.target.value)}
                  placeholder="예: 50"
                  className="w-full px-3 py-2 bg-hanok-card border border-hanok-line rounded-lg text-sm text-hanok-ink placeholder-hanok-muted focus:outline-none focus:border-gold/60"
                />
              </div>

              {formError && (
                <p className="text-xs font-medium text-rose-400">{formError}</p>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  disabled={submitting}
                  className="px-4 py-2 rounded-lg text-sm font-semibold text-hanok-muted bg-hanok-card border border-hanok-line hover:bg-hanok-line transition-colors disabled:opacity-50"
                >
                  취소
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 rounded-lg text-sm font-bold text-white bg-gold hover:bg-gold-deep transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {submitting ? '저장 중...' : modalMode === 'create' ? '등록' : '저장'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
