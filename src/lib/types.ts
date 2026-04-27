export type Priority = 'High impact' | 'Worth exploring' | 'Optional polish'
export type RecommendationTarget =
  | 'Overall mix'
  | 'Vocal'
  | 'Drums'
  | 'Bass'
  | 'Instruments'
  | 'Stereo field'
  | 'Mix bus'
  | 'Tonal balance'
  | 'Drum balance'
  | 'Vocal level'

export interface Recommendation {
  title: string
  detail: string
  priority: Priority
  estimatedLift: string
  target: RecommendationTarget
}

export interface Strength {
  title: string
  detail: string
}

export interface MetricInsight {
  title: string
  meaning: string
  influencedBy: string
  currentRead: string
}

export interface BalanceStripItem {
  key: string
  label: string
  range: string
  deviationPercent: number
  status: 'low' | 'good' | 'high'
  severity: 'good' | 'watch' | 'fix'
  action: string
}

export interface TonalBalanceBand extends BalanceStripItem {
  key: 'weight' | 'body' | 'core' | 'air'
}

export interface LevelBalanceStrip {
  vocals: BalanceStripItem
  drums: BalanceStripItem
  kick: BalanceStripItem
  snare: BalanceStripItem
  cymbals: BalanceStripItem
}

export interface ImpactStrip extends BalanceStripItem {
  earCheck: string[]
}


export interface SectionMetrics {
  clarity: number
  impact: number
  tonalBalance: number
  width: number
  mood: number
  drumsVsEverything: number
  vocalLevel: number
}

export interface SectionAnalysis {
  id: string
  label: string
  start: number
  end: number
  score: number
  status: string
  color: string
  highlightLevel: 0 | 1 | 2 | 3 | 4
  strengths: Strength[]
  recommendations: Recommendation[]
  metrics: SectionMetrics
  metricInsights: Record<keyof SectionMetrics, MetricInsight>
  tonalBalanceBands?: TonalBalanceBand[]
  clarityBands?: BalanceStripItem[]
  levelBalance?: LevelBalanceStrip
  impactStrip?: ImpactStrip
}
