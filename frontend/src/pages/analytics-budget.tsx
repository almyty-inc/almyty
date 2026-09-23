/* /analytics/budgets/new and /analytics/budgets/:budgetId/edit -- the spend
 * budget form. The form lives in components/analytics/budget-form.tsx. */
import { useEffect } from 'react'
import { useParams } from 'react-router-dom'

import { BudgetFormPage } from '@/components/analytics/budget-form'

export function AnalyticsBudgetPage() {
  const { budgetId } = useParams<{ budgetId?: string }>()
  useEffect(() => {
    document.title = `${budgetId ? 'Edit spend budget' : 'New spend budget'} | almyty`
    return () => {
      document.title = 'almyty'
    }
  }, [budgetId])
  return <BudgetFormPage />
}
