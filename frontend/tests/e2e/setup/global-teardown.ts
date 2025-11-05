import { FullConfig } from '@playwright/test'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

/**
 * Global teardown runs once after all tests
 * Optionally stops Docker services and cleans up
 */
async function globalTeardown(config: FullConfig) {
  console.log('\n🧹 Running E2E test environment teardown...\n')

  // Only stop services if E2E_STOP_SERVICES is set
  if (process.env.E2E_STOP_SERVICES === 'true') {
    console.log('🛑 Stopping Docker Compose services...')
    try {
      await execAsync('cd ../../../ && docker-compose down')
      console.log('✓ Services stopped')
    } catch (error) {
      console.error('✗ Failed to stop services:', error)
    }
  } else {
    console.log('ℹ️  Leaving services running (set E2E_STOP_SERVICES=true to stop)')
  }

  // Clean up test artifacts
  console.log('\n🗑️  Cleaning up test artifacts...')
  try {
    // Remove screenshots and videos from failed tests if desired
    if (process.env.E2E_CLEAN_ARTIFACTS === 'true') {
      await execAsync('rm -rf playwright-report/')
      await execAsync('rm -rf test-results/')
      console.log('✓ Test artifacts cleaned')
    } else {
      console.log('ℹ️  Keeping test artifacts for review')
    }
  } catch (error) {
    console.warn('⚠ Cleanup failed:', error)
  }

  console.log('\n✅ Teardown complete!\n')
}

export default globalTeardown
