export type InfrastructureType = 'cafeteria' | 'parking' | 'meeting_room' | 'rest_area';
export interface Infrastructure {
    id: string;
    name: string;
    type: InfrastructureType;
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
    infrastructureId: string;
    currentOccupancy: number;
    congestionRate: number;
    status: 'smooth' | 'normal' | 'crowded' | 'critical';
    recordedAt: string;
}
export interface Reservation {
    id: string;
    infrastructureId: string;
    userId: string;
    startTime: string;
    endTime: string;
    status: 'confirmed' | 'cancelled' | 'completed';
    createdAt: string;
}
export interface TTTVRecommendation {
    id?: string;
    userId?: string;
    requestedInfraId: string;
    recommendedInfraId: string;
    recommendedInfraName?: string;
    originalEstimatedWaitTime: number;
    recommendedEstimatedWaitTime: number;
    travelTimeSaved: number;
    reason?: string;
    status: 'offered' | 'accepted' | 'rejected';
    createdAt?: string;
}
