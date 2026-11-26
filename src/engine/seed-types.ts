// data/seed/teams_m7.json の形。
export interface SeedMon {
  species: string; jp: string; item: string; ability: string; nature: string;
  evs: Record<'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe', number>;
  moves: string[];
}
export interface SeedTeam { rank: number; season: string; article_url: string | null; mons: SeedMon[] }
