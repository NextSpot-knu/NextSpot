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

// 실데이터 전용: Supabase facilities + 최신 congestion_logs 만 사용한다(목업 폴백 없음).
export default async function GyeongjuMapPage() {
  const supabase = createPublicClient();
  let facilitiesData: any[] = [];
  const latestLogsMap: Record<string, any> = {};

  try {
    // 1) 모든 POI 조회 (페이지네이션)
    let facilities: any[] = [];
    let fromFac = 0;
    const limit = 1000;
    while (true) {
      const { data, error } = await supabase
        .from("facilities")
        .select("id, name, type, latitude, longitude, capacity, operating_hours, features")
        .order("name", { ascending: true })
        .range(fromFac, fromFac + limit - 1);

      if (error) {
        console.warn("Supabase facilities query error:", error);
        break;
      }
      if (!data || data.length === 0) break;
      facilities = [...facilities, ...data];
      if (data.length < limit) break;
      fromFac += limit;
    }
    facilitiesData = facilities;

    // 2) 각 POI의 최신 congestion_log 조회 (페이지네이션)
    if (facilitiesData.length > 0) {
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

      // facility_id 기준으로 최신 로그 1개씩만 유지
      for (const log of logs) {
        if (!latestLogsMap[log.facility_id]) {
          latestLogsMap[log.facility_id] = log;
        }
      }
    }
  } catch (err) {
    console.warn("Failed to connect to Supabase:", err);
    facilitiesData = [];
  }

  const initialFacilities: FacilityWithCongestion[] = facilitiesData.map((f: any) => {
    const latestLog = latestLogsMap[f.id];
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
