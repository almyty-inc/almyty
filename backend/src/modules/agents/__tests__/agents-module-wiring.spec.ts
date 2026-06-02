import { AgentsModule } from '../agents.module'
import { AgentExecutionController } from '../agent-execution.controller'

// Regression for #113: AgentExecutionController was imported but
// missing from the @Module's controllers array, so the agent
// execution routes 404'd in prod. Mirror of memory-module-wiring.

describe('AgentsModule wiring', () => {
  it('registers AgentExecutionController on the module', () => {
    const controllers = Reflect.getMetadata('controllers', AgentsModule) ?? []
    expect(controllers).toContain(AgentExecutionController)
  })
})
