'use client';

import { useState, useEffect } from 'react';
import { Settings, Plus, Edit2, Trash2, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
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

export function FacilityTable() {
  const [facilities, setFacilities] = useState<FacilityData[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCategory, setSelectedCategory] = useState('restaurant');
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  const categories = [
    { id: 'restaurant', name: '음식점' },
    { id: 'cafe', name: '카페' },
    { id: 'attraction', name: '관광지' },
    { id: 'culture', name: '문화시설' },
  ];

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

  const handleDelete = async (id: string, name: string) => {
    if (confirm(`정말로 이 시설(${name})을 삭제하시겠습니까?`)) {
      try {
        await adminApi.delete(`/api/v1/admin/facilities/${id}`);
        setFacilities(prev => prev.filter(f => f.id !== id));
      } catch (err: any) {
        console.error('Failed to delete facility:', err);
        alert(`시설 삭제 중 오류가 발생했습니다: ${err?.message || '알 수 없는 오류'}`);
      }
    }
  };

  const getHoursText = (hours?: Record<string, string>) => {
    if (!hours) return '24시간';
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
    <div className="bg-slate-900 rounded-2xl border border-slate-800 shadow-sm overflow-hidden col-span-2">
      <div className="p-6 border-b border-slate-800 flex justify-between items-center bg-slate-800/30">
        <div className="flex items-center gap-2">
          <Settings className="text-slate-400" size={20} />
          <h3 className="text-lg font-bold text-slate-100">장소 관리 (CRUD)</h3>
        </div>
        <button 
          onClick={() => {
            const name = prompt('새로운 장소명을 입력하세요:');
            if (!name) return;
            const type = prompt('장소 유형을 입력하세요 (restaurant, cafe, attraction, culture):', selectedCategory);
            if (!type) return;
            if (!['restaurant', 'cafe', 'attraction', 'culture'].includes(type)) {
              alert('올바른 유형을 입력하세요 (restaurant, cafe, attraction, culture).');
              return;
            }
            const capacityStr = prompt('수용 인원(숫자)을 입력하세요:', '50');
            const capacity = parseInt(capacityStr || '50') || 50;

            adminApi
              .post('/api/v1/admin/facilities', { name, type, capacity, latitude: REGION.center.lat, longitude: REGION.center.lng }) // 신규 시설 기본좌표 = 지역 중심점(lib/region.ts)
              .then(() => {
                alert('시설이 성공적으로 등록되었습니다.');
                fetchFacilities();
              })
              .catch((err: any) => {
                alert('시설 등록에 실패했습니다: ' + (err?.message || '알 수 없는 오류'));
              });
          }}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-bold transition-colors"
        >
          <Plus size={16} /> 신규 장소 등록
        </button>
      </div>

      {/* Category Tabs */}
      <div className="flex gap-2 p-4 border-b border-slate-800 bg-slate-900/50">
        {categories.map((cat) => (
          <button
            key={cat.id}
            onClick={() => {
              setSelectedCategory(cat.id);
              setCurrentPage(1);
            }}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
              selectedCategory === cat.id
                ? 'bg-blue-500/25 border-blue-500/50 text-blue-400 font-bold shadow-sm'
                : 'bg-slate-800/80 border-slate-700/80 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
            }`}
          >
            {cat.name}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto">
        {loading ? (
          <div className="p-8 text-center text-slate-500">데이터 로딩 중...</div>
        ) : (
          <>
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-900 text-slate-400 text-sm border-b border-slate-800">
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
                  <tr key={fac.id} className="border-b border-slate-800 hover:bg-slate-800 transition-colors">
                    <td className="p-4 font-bold text-slate-100">{fac.name}</td>
                    <td className="p-4">
                      <span className="px-2 py-1 bg-slate-800 text-slate-300 rounded-md text-xs font-semibold uppercase">
                        {fac.type === 'restaurant' ? '음식점' : fac.type === 'cafe' ? '카페' : fac.type === 'attraction' ? '관광지' : fac.type === 'culture' ? '문화시설' : fac.type}
                      </span>
                    </td>
                    <td className="p-4 text-slate-300">{fac.capacity}명/대</td>
                    <td className="p-4 text-slate-300">{getHoursText(fac.operating_hours)}</td>
                    <td className="p-4">
                      <span className="px-2 py-1 bg-emerald-500/15 text-emerald-300 text-xs font-bold rounded-md">활성</span>
                    </td>
                    <td className="p-4 flex justify-end gap-2">
                      <button 
                        onClick={() => {
                          const newName = prompt('수정할 시설명을 입력하세요:', fac.name);
                          if (!newName) return;
                          const newCapStr = prompt('수정할 수용 인원을 입력하세요:', String(fac.capacity));
                          const newCapacity = parseInt(newCapStr || '50') || fac.capacity;

                          adminApi
                            .patch(`/api/v1/admin/facilities/${fac.id}`, { name: newName, capacity: newCapacity })
                            .then(() => {
                              alert('시설 정보가 수정되었습니다.');
                              fetchFacilities();
                            })
                            .catch((err: any) => {
                              alert('시설 정보 수정 실패: ' + (err?.message || '알 수 없는 오류'));
                            });
                        }}
                        className="p-1.5 text-slate-500 hover:text-blue-400 transition-colors bg-slate-900 border border-slate-800 rounded-md"
                      >
                        <Edit2 size={16} />
                      </button>
                      <button 
                        onClick={() => handleDelete(fac.id, fac.name)}
                        className="p-1.5 text-slate-500 hover:text-rose-400 transition-colors bg-slate-900 border border-slate-800 rounded-md"
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
                {filteredFacilities.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center p-8 text-slate-500 font-medium">등록된 장소가 없습니다.</td>
                  </tr>
                )}
              </tbody>
            </table>

            {/* Pagination Controls */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between border-t border-slate-800 p-4 bg-slate-900/30">
                <div className="text-xs text-slate-400 font-medium">
                  총 {totalItems}개 중 {startIndex + 1}-{Math.min(startIndex + itemsPerPage, totalItems)}개 표시
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setCurrentPage(prev => Math.max(prev - 10, 1))}
                    disabled={currentPage === 1}
                    title="10페이지 이전"
                    className="p-1 rounded border border-slate-800 text-slate-400 hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronsLeft size={16} />
                  </button>
                  <button
                    onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                    disabled={currentPage === 1}
                    title="이전 페이지"
                    className="p-1 rounded border border-slate-800 text-slate-400 hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <span className="text-xs text-slate-300 font-semibold px-2">
                    {currentPage} / {totalPages}
                  </span>
                  <button
                    onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                    disabled={currentPage === totalPages}
                    title="다음 페이지"
                    className="p-1 rounded border border-slate-800 text-slate-400 hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronRight size={16} />
                  </button>
                  <button
                    onClick={() => setCurrentPage(prev => Math.min(prev + 10, totalPages))}
                    disabled={currentPage === totalPages}
                    title="10페이지 다음"
                    className="p-1 rounded border border-slate-800 text-slate-400 hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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
  );
}
