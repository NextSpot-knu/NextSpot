// ──────────────────────────────────────────
// Supabase Table Types
// ──────────────────────────────────────────

export interface Facility {
  id: string;
  name: string;
  type: string;
  latitude: number;
  longitude: number;
  capacity: number;
  operating_hours: Record<string, string>;
  features: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CongestionLog {
  id: string;
  facility_id: string;
  timestamp: string;
  current_count: number;
  congestion_level: number;
  source: string;
}

export interface Recommendation {
  id: string;
  user_id: string;
  original_facility_id: string;
  recommended_facility_id: string;
  tttv_score: number;
  score_breakdown: Record<string, unknown>;
  accepted: boolean;
  created_at: string;
}

export interface UserFeedback {
  id: string;
  user_id: string;
  recommendation_id: string;
  action: string;
  timestamp: string;
}

export interface User {
  id: string;
  employee_id: string;
  company_name: string;
  preferred_categories: string[];
  work_shift: string;
  role: string;
  created_at: string;
  updated_at: string;
}

// ──────────────────────────────────────────
// Dashboard-Specific Types
// ──────────────────────────────────────────

export interface DashboardKPI {
  avgCongestion: { value: number; changePercent: number };
  acceptRate: { value: number; total: number; accepted: number };
  activeUsers: number;
  anomalyCount: number;
}

export interface HeatmapCell {
  facility: string;
  facilityType: string;
  hour: number;
  value: number;
}

export interface DistributionDataPoint {
  date: string;
  beforeCongestion: number;
  afterCongestion: number;
  alternativeUsage: number;
}

export interface AnomalyAlert {
  id: string;
  facilityName: string;
  facilityId: string;
  timestamp: string;
  congestionLevel: number;
  durationMinutes: number;
}
