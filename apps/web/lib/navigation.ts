export interface NavigationFacility { name: string; latitude: number; longitude: number }

export function openWalkingDirections(facility: NavigationFacility): void {
  const query = encodeURIComponent(facility.name);
  // Kakao does not provide a stable walking deep-link across all environments.
  // Open the destination page and let the user explicitly select walking.
  const url = `https://map.kakao.com/link/map/${query},${facility.latitude},${facility.longitude}`;
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  if (!opened) window.location.href = url;
}

export function openDrivingDirections(facility: NavigationFacility): void {
  const url = `https://map.kakao.com/link/to/${encodeURIComponent(facility.name)},${facility.latitude},${facility.longitude}`;
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  if (!opened) window.location.href = url;
}
