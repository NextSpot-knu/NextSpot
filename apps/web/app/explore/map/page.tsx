import React from "react";
import { createPublicClient } from "@/lib/supabase";
import CongestionMap from "@/components/map/CongestionMap";

export const revalidate = 0;

export interface FacilityWithCongestion {
  id: string;
  name: string;
  type: "restaurant" | "cafe" | "attraction" | "culture";
  latitude: number;
  longitude: number;
  capacity: number;
  operatingHours: Record<string, any>;
  features: Record<string, any>;
  congestionLevel: number;
  currentCount: number;
  lastUpdated: string;
}

// 데모 폴백 — Supabase 미연결 시 사용. seed.sql 의 경주 황리단길 POI 와 동일한 id/좌표.
const MOCK_SEED_FACILITIES = [
  {
    id: "f1000000-0000-0000-0000-000000000001",
    name: "황남쌈밥",
    type: "restaurant",
    latitude: 35.8378,
    longitude: 129.2096,
    capacity: 60,
    operating_hours: { weekday: "10:30-21:00", weekend: "10:30-21:00" },
    features: { cuisine_tags: ["한식", "쌈밥"], signature_menu: "보리쌈밥정식", barrier_free: true, average_price: 13000, average_processing_time: 25 },
    congestion_logs: [{ congestion_level: 0.85, current_count: 51, timestamp: new Date().toISOString() }]
  },
  {
    id: "f1000000-0000-0000-0000-000000000002",
    name: "교리김밥 황리단길점",
    type: "restaurant",
    latitude: 35.8369,
    longitude: 129.2103,
    capacity: 30,
    operating_hours: { weekday: "08:00-18:00", weekend: "08:00-18:00" },
    features: { cuisine_tags: ["분식", "김밥"], signature_menu: "교리김밥", average_price: 6000, average_processing_time: 20 },
    congestion_logs: [{ congestion_level: 0.45, current_count: 13, timestamp: new Date().toISOString() }]
  },
  {
    id: "f1000000-0000-0000-0000-000000000003",
    name: "황리단길 한우국밥",
    type: "restaurant",
    latitude: 35.8362,
    longitude: 129.2091,
    capacity: 50,
    operating_hours: { weekday: "09:00-20:00", weekend: "09:00-20:00" },
    features: { cuisine_tags: ["한식", "국밥"], signature_menu: "한우국밥", barrier_free: false, average_price: 10000, average_processing_time: 25 },
    congestion_logs: [{ congestion_level: 0.20, current_count: 10, timestamp: new Date().toISOString() }]
  },
  {
    id: "f2000000-0000-0000-0000-000000000001",
    name: "황리단길 감성카페 봄",
    type: "cafe",
    latitude: 35.8366,
    longitude: 129.2099,
    capacity: 40,
    operating_hours: { weekday: "10:00-22:00", weekend: "10:00-23:00" },
    features: { signature_menu: "황남빵라떼", instagrammable: true, average_price: 6500, average_processing_time: 12 },
    congestion_logs: [{ congestion_level: 0.75, current_count: 30, timestamp: new Date().toISOString() }]
  },
  {
    id: "f2000000-0000-0000-0000-000000000002",
    name: "한옥카페 다랑",
    type: "cafe",
    latitude: 35.8372,
    longitude: 129.2085,
    capacity: 35,
    operating_hours: { weekday: "10:30-21:00", weekend: "10:00-22:00" },
    features: { signature_menu: "쑥라떼", instagrammable: true, barrier_free: false, average_price: 7000, average_processing_time: 12 },
    congestion_logs: [{ congestion_level: 0.55, current_count: 19, timestamp: new Date().toISOString() }]
  },
  {
    id: "f2000000-0000-0000-0000-000000000004",
    name: "십원빵 황리단길",
    type: "cafe",
    latitude: 35.8375,
    longitude: 129.2094,
    capacity: 20,
    operating_hours: { weekday: "10:00-21:00", weekend: "10:00-21:30" },
    features: { signature_menu: "십원빵", instagrammable: true, average_price: 4000, average_processing_time: 12 },
    congestion_logs: [{ congestion_level: 0.15, current_count: 3, timestamp: new Date().toISOString() }]
  },
  {
    id: "f3000000-0000-0000-0000-000000000001",
    name: "대릉원(천마총)",
    type: "attraction",
    latitude: 35.8389,
    longitude: 129.2099,
    capacity: 800,
    operating_hours: { weekday: "09:00-22:00", weekend: "09:00-22:00" },
    features: { barrier_free: true, entry_fee: 3000, category: "고분군", average_processing_time: 15 },
    congestion_logs: [{ congestion_level: 0.90, current_count: 720, timestamp: new Date().toISOString() }]
  },
  {
    id: "f3000000-0000-0000-0000-000000000002",
    name: "첨성대",
    type: "attraction",
    latitude: 35.8347,
    longitude: 129.2189,
    capacity: 600,
    operating_hours: { weekday: "00:00-24:00", weekend: "00:00-24:00" },
    features: { barrier_free: true, entry_fee: 0, category: "유적", average_processing_time: 15 },
    congestion_logs: [{ congestion_level: 0.70, current_count: 420, timestamp: new Date().toISOString() }]
  },
  {
    id: "f3000000-0000-0000-0000-000000000003",
    name: "동궁과 월지",
    type: "attraction",
    latitude: 35.8348,
    longitude: 129.2265,
    capacity: 700,
    operating_hours: { weekday: "09:00-22:00", weekend: "09:00-22:00" },
    features: { barrier_free: true, entry_fee: 3000, category: "야경", average_processing_time: 15 },
    congestion_logs: [{ congestion_level: 0.35, current_count: 245, timestamp: new Date().toISOString() }]
  },
  {
    id: "f4000000-0000-0000-0000-000000000001",
    name: "국립경주박물관",
    type: "culture",
    latitude: 35.8297,
    longitude: 129.2278,
    capacity: 500,
    operating_hours: { weekday: "10:00-18:00", weekend: "10:00-19:00", closed: "monday" },
    features: { barrier_free: true, entry_fee: 0, category: "박물관", average_processing_time: 15 },
    congestion_logs: [{ congestion_level: 0.50, current_count: 250, timestamp: new Date().toISOString() }]
  },
  {
    id: "f4000000-0000-0000-0000-000000000002",
    name: "경주 교촌마을",
    type: "culture",
    latitude: 35.8296,
    longitude: 129.2156,
    capacity: 300,
    operating_hours: { weekday: "09:00-18:00", weekend: "09:00-18:00" },
    features: { barrier_free: false, entry_fee: 0, category: "한옥마을", average_processing_time: 15 },
    congestion_logs: [{ congestion_level: 0.30, current_count: 90, timestamp: new Date().toISOString() }]
  },
  {
    id: "f4000000-0000-0000-0000-000000000004",
    name: "황리단길 공예공방거리",
    type: "culture",
    latitude: 35.8360,
    longitude: 129.2085,
    capacity: 100,
    operating_hours: { weekday: "10:00-19:00", weekend: "10:00-20:00" },
    features: { barrier_free: true, entry_fee: 0, category: "공예", average_processing_time: 15 },
    congestion_logs: [{ congestion_level: 0.15, current_count: 15, timestamp: new Date().toISOString() }]
  }
];

export default async function GyeongjuMapPage() {
  const supabase = createPublicClient();
  let facilitiesData: any[] = [];
  let latestLogsMap: Record<string, any> = {};

  try {
    // 1) 모든 POI 조회 (congestion_logs 조인 없이, 페이지네이션 적용)
    let facilities: any[] = [];
    let fromFac = 0;
    const limit = 1000;
    let facilityError = null;

    while (true) {
      const { data, error } = await supabase
        .from("facilities")
        .select("id, name, type, latitude, longitude, capacity, operating_hours, features")
        .order("name", { ascending: true })
        .range(fromFac, fromFac + limit - 1);

      if (error) {
        facilityError = error;
        break;
      }
      if (!data || data.length === 0) break;
      facilities = [...facilities, ...data];
      if (data.length < limit) break;
      fromFac += limit;
    }

    if (facilityError) {
      console.warn("Supabase facilities query error, using fallback:", facilityError);
      facilitiesData = MOCK_SEED_FACILITIES;
    } else if (facilities.length === 0) {
      console.warn("No facilities returned from Supabase, using fallback.");
      facilitiesData = MOCK_SEED_FACILITIES;
    } else {
      facilitiesData = facilities;

      // 2) 각 POI의 최신 congestion_log 조회 (페이지네이션 적용)
      let logs: any[] = [];
      let fromLogs = 0;
      while (true) {
        const { data, error } = await supabase
          .from("congestion_logs")
          .select("facility_id, congestion_level, current_count, timestamp")
          .order("timestamp", { ascending: false })
          .range(fromLogs, fromLogs + limit - 1);

        if (error) {
          console.warn("Failed to load congestion logs:", error);
          break;
        }
        if (!data || data.length === 0) break;
        logs = [...logs, ...data];
        if (data.length < limit) break;
        fromLogs += limit;
      }

      if (logs && logs.length > 0) {
        // facility_id 기준으로 최신 로그 1개씩만 유지
        for (const log of logs) {
          if (!latestLogsMap[log.facility_id]) {
            latestLogsMap[log.facility_id] = log;
          }
        }
      }
    }
  } catch (err) {
    console.warn("Failed to connect to Supabase, falling back to mock seed facilities:", err);
    facilitiesData = MOCK_SEED_FACILITIES;
  }


  const initialFacilities: FacilityWithCongestion[] = facilitiesData.map((f: any) => {
    // Supabase에서 조회한 경우 latestLogsMap에 존재, mock의 경우 f.congestion_logs에 존재
    const latestLog = latestLogsMap[f.id] || (f.congestion_logs && f.congestion_logs[0]);
    return {
      id: f.id,
      name: f.name,
      type: f.type,
      latitude: f.latitude,
      longitude: f.longitude,
      capacity: f.capacity,
      operatingHours: f.operating_hours || {},
      features: f.features || {},
      congestionLevel: latestLog ? latestLog.congestion_level : 0.0,
      currentCount: latestLog ? latestLog.current_count : 0,
      lastUpdated: latestLog ? latestLog.timestamp : new Date().toISOString(),
    };
  });

  return (
    <div className="min-h-screen bg-[#0a0f1e] text-white">
      <CongestionMap initialFacilities={initialFacilities} />
    </div>
  );
}
