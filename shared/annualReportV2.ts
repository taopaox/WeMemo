import manifests from './annualReportV2.json'
export interface AnnualV2Card {
  id: number
  title: string
  kind: string
  scope: 'global'
  category: string
  status: 'ok' | 'error'
  narrative: string
  data: Record<string, any> | null
  error?: string
}
export const annualV2Manifests = manifests.map(card => ({ ...card, scope: 'global' as const }))
export const validAnnualV2Year = (year: unknown): year is number => Number.isInteger(year) && Number(year) >= 2000 && Number(year) <= new Date().getFullYear()
