const clubLeagueMap = new Map<string, string>();

export function resolveLeagueId(npcClubId: string): string {
  return clubLeagueMap.get(npcClubId) ?? '';
}
