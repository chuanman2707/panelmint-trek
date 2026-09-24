import type { MTripTabPanelProps } from '../MTripShell'
import { TabScroller } from './tabChrome'
import MTransportsTab from './MTransportsTab'
import MBookingsTab from './MBookingsTab'
import MCostsTab from './MCostsTab'
import MListsTab from './MListsTab'
import MRoadtripTab from '../roadtrip/MRoadtripTab'

/**
 * Routes the active non-plan trip tab to its panel. `tab` is the legacy id the
 * desktop planner uses (transports · buchungen · finanzplan · listen ·
 * roadtrip); addon gating already happened in the shell, so only enabled tabs
 * ever reach here.
 */
export default function MTripTabPanel({ planner, shell, tab }: MTripTabPanelProps) {
  switch (tab) {
    case 'transports':
      return <MTransportsTab planner={planner} shell={shell} />
    case 'buchungen':
      return <MBookingsTab planner={planner} shell={shell} />
    case 'finanzplan':
      return <MCostsTab planner={planner} shell={shell} />
    case 'listen':
      return <MListsTab planner={planner} shell={shell} />
    // The only tab with two halves of its own: the chain, or the same map showing
    // the stage. Both are this one component, because they share a stage and the
    // switch between them must not lose it.
    case 'roadtrip':
      return <MRoadtripTab planner={planner} shell={shell} tab={tab} />
    default:
      return <TabScroller>{null}</TabScroller>
  }
}
