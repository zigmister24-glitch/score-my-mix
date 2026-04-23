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

export interface SectionMetrics {
  clarity: number
  impact: number
  tonalBalance: number
  width: number
  mood: number
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
}
