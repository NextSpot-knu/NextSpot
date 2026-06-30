export type FacilityType = 'restaurant' | 'cafe' | 'attraction' | 'culture';
export interface Facility {
    id: string;
    name: string;
    type: FacilityType;
    location?: string;
    latitude?: number;
    longitude?: number;
    capacity: number;
    congestionThreshold: number;
    createdAt: string;
    updatedAt: string;
}
export interface CongestionLog {
    id: string;
    facilityId: string;
    currentCount: number;
    congestionRate: number;
    status: 'smooth' | 'normal' | 'crowded' | 'critical';
    recordedAt: string;
}
export interface TTTVRecommendation {
    id?: string;
    userId?: string;
    requestedFacilityId: string;
    recommendedFacilityId: string;
    recommendedFacilityName?: string;
    originalEstimatedWaitTime: number;
    recommendedEstimatedWaitTime: number;
    travelTimeSaved: number;
    reason?: string;
    status: 'offered' | 'accepted' | 'rejected';
    createdAt?: string;
}
