import React from "react";
import { createPublicClient } from "@/lib/supabase";
import CongestionMap from "@/components/map/CongestionMap";

export const revalidate = 0;

export interface FacilityWithCongestion {
  id: string;
  name: string;
  type: "cafeteria" | "parking" | "meeting_room" | "rest_area";
  latitude: number;
  longitude: number;
  capacity: number;
  operatingHours: Record<string, any>;
  features: Record<string, any>;
  congestionLevel: number;
  currentCount: number;
  lastUpdated: string;
}

const MOCK_SEED_FACILITIES = [
  {
    id: "f1000000-0000-0000-0000-000000000001",
    name: "푸드스퀘어 한식관",
    type: "cafeteria",
    latitude: 36.1198,
    longitude: 128.3471,
    capacity: 150,
    operating_hours: { weekday: "11:00-20:00", weekend: "11:00-14:00" },
    features: { has_vegetarian: true, average_price: 7500, average_processing_time: 20 },
    congestion_logs: [{ congestion_level: 0.85, current_count: 127, timestamp: new Date().toISOString() }]
  },
  {
    id: "f1000000-0000-0000-0000-000000000002",
    name: "Indu 뷔페 식당",
    type: "cafeteria",
    latitude: 36.1215,
    longitude: 128.3497,
    capacity: 200,
    operating_hours: { weekday: "11:30-19:00", weekend: "closed" },
    features: { buffet_style: true, average_price: 8000, average_processing_time: 20 },
    congestion_logs: [{ congestion_level: 0.45, current_count: 90, timestamp: new Date().toISOString() }]
  },
  {
    id: "f1000000-0000-0000-0000-000000000003",
    name: "단지내 중식당 화성",
    type: "cafeteria",
    latitude: 36.1228,
    longitude: 128.3454,
    capacity: 80,
    operating_hours: { weekday: "11:00-21:00", weekend: "11:00-15:00" },
    features: { has_delivery: true, average_price: 9000, average_processing_time: 20 },
    congestion_logs: [{ congestion_level: 0.20, current_count: 16, timestamp: new Date().toISOString() }]
  },
  {
    id: "f1000000-0000-0000-0000-000000000004",
    name: "밀스밀 간편식 코너",
    type: "cafeteria",
    latitude: 36.1184,
    longitude: 128.3508,
    capacity: 50,
    operating_hours: { weekday: "08:00-22:00", weekend: "09:00-18:00" },
    features: { sandwich_bar: true, average_price: 5500, average_processing_time: 15 },
    congestion_logs: [{ congestion_level: 0.15, current_count: 7, timestamp: new Date().toISOString() }]
  },
  {
    id: "f1000000-0000-0000-0000-000000000005",
    name: "산단 남부 한식뷔페",
    type: "cafeteria",
    latitude: 36.1243,
    longitude: 128.3476,
    capacity: 180,
    operating_hours: { weekday: "11:00-18:30", weekend: "closed" },
    features: { buffet_style: true, average_price: 7000, average_processing_time: 20 },
    congestion_logs: [{ congestion_level: 0.75, current_count: 135, timestamp: new Date().toISOString() }]
  },
  {
    id: "f2000000-0000-0000-0000-000000000001",
    name: "중앙 주차타워 A동",
    type: "parking",
    latitude: 36.1208,
    longitude: 128.3486,
    capacity: 400,
    operating_hours: { "24_7": true },
    features: { has_ev_charger: true, indoor: true, average_processing_time: 5 },
    congestion_logs: [{ congestion_level: 0.90, current_count: 360, timestamp: new Date().toISOString() }]
  },
  {
    id: "f2000000-0000-0000-0000-000000000002",
    name: "지상 남부 주차장",
    type: "parking",
    latitude: 36.1255,
    longitude: 128.3461,
    capacity: 250,
    operating_hours: { "24_7": true },
    features: { has_ev_charger: false, indoor: false, average_processing_time: 5 },
    congestion_logs: [{ congestion_level: 0.35, current_count: 87, timestamp: new Date().toISOString() }]
  },
  {
    id: "f2000000-0000-0000-0000-000000000003",
    name: "서부 복합주차장 B",
    type: "parking",
    latitude: 36.1173,
    longitude: 128.3441,
    capacity: 300,
    operating_hours: { "24_7": true },
    features: { has_ev_charger: true, indoor: true, average_processing_time: 5 },
    congestion_logs: [{ congestion_level: 0.10, current_count: 30, timestamp: new Date().toISOString() }]
  },
  {
    id: "f3000000-0000-0000-0000-000000000001",
    name: "본관 1층 컨퍼런스룸 101",
    type: "meeting_room",
    latitude: 36.1203,
    longitude: 128.3481,
    capacity: 30,
    operating_hours: { weekday: "09:00-18:00", weekend: "closed" },
    features: { has_beam_projector: true, has_video_conf: true, average_processing_time: 10 },
    congestion_logs: [{ congestion_level: 0.50, current_count: 15, timestamp: new Date().toISOString() }]
  },
  {
    id: "f3000000-0000-0000-0000-000000000002",
    name: "혁신센터 스마트회의실 B",
    type: "meeting_room",
    latitude: 36.1221,
    longitude: 128.3511,
    capacity: 12,
    operating_hours: { weekday: "08:00-20:00", weekend: "09:00-18:00" },
    features: { has_beam_projector: true, whiteboard: true, average_processing_time: 10 },
    congestion_logs: [{ congestion_level: 0.80, current_count: 10, timestamp: new Date().toISOString() }]
  },
  {
    id: "f4000000-0000-0000-0000-000000000001",
    name: "북부 직원 휴게라운지 D-1",
    type: "rest_area",
    latitude: 36.1263,
    longitude: 128.3501,
    capacity: 10,
    operating_hours: { "24_7": true },
    features: { massageChairs: { inUse: 3, total: 3 }, sleepCapsules: { inUse: 2, total: 2 }, playstation: { inUse: 1, total: 1 }, average_processing_time: 10 },
    congestion_logs: [{ congestion_level: 0.95, current_count: 9, timestamp: new Date().toISOString() }]
  },
  {
    id: "f4000000-0000-0000-0000-000000000002",
    name: "남부 직원 휴게라운지 E-2",
    type: "rest_area",
    latitude: 36.1163,
    longitude: 128.3466,
    capacity: 6,
    operating_hours: { "24_7": true },
    features: { massageChairs: { inUse: 0, total: 3 }, sleepCapsules: { inUse: 0, total: 2 }, playstation: { inUse: 0, total: 1 }, average_processing_time: 10 },
    congestion_logs: [{ congestion_level: 0.15, current_count: 1, timestamp: new Date().toISOString() }]
  }
];

export default async function WorkerMapPage() {
  const supabase = createPublicClient();
  let facilitiesData: any[] = [];
  let latestLogsMap: Record<string, any> = {};

  try {
    // 1) 모든 시설 조회 (congestion_logs 조인 없이, 페이지네이션 적용)
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

      // 2) 각 시설의 최신 congestion_log 조회 (페이지네이션 적용)
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
