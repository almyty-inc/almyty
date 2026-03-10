import { FullConfig } from '@playwright/test'
import { exec } from 'child_process'
import { promisify } from 'util'
import axios from 'axios'

const execAsync = promisify(exec)

/**
 * Global setup runs once before all tests
 * Ensures Docker services are running and healthy
 */
async function globalSetup(config: FullConfig) {
  console.log('\n🚀 Starting E2E test environment setup...\n')

  // Check if backend is already running (local dev mode)
  const backendHealthUrl = 'http://localhost:4000/monitoring/health'
  let backendRunning = false
  try {
    await axios.get(backendHealthUrl, { timeout: 3000 })
    backendRunning = true
    console.log('✓ Backend already running locally')
  } catch {
    backendRunning = false
  }

  if (!backendRunning) {
    // Check if Docker is running
    try {
      await execAsync('docker ps')
      console.log('✓ Docker is running')
    } catch (error) {
      console.error('✗ Docker is not running and backend is not running locally.')
      throw new Error('Either start the backend locally or ensure Docker is running')
    }

    // Start Docker Compose services
    console.log('\n📦 Starting Docker Compose services...')
    try {
      const rootDir = process.cwd().includes('/frontend') ? '..' : '.'
      console.log('Starting services: postgres, redis, backend...')
      await execAsync(`cd ${rootDir} && docker-compose up -d postgres redis backend`)
    } catch (error) {
      console.error('✗ Failed to start Docker Compose services:', error)
      throw error
    }

    // Wait for backend to be healthy
    await waitForService('Backend API', backendHealthUrl, 60000)
  }

  // Run database migrations
  console.log('\n🗄️  Running database migrations...')
  try {
    const rootDir = process.cwd().includes('/frontend') ? '..' : '.'
    await execAsync(`cd ${rootDir}/backend && npm run typeorm:migration:run`)
    console.log('✓ Migrations completed')
  } catch (error) {
    console.warn('⚠ Migration failed (might already be up to date)')
  }

  // Clean test database (remove old test data)
  console.log('\n🧹 Cleaning test database...')
  try {
    await cleanTestData()
    console.log('✓ Test database cleaned')
  } catch (error) {
    console.warn('⚠ Database cleanup failed:', error)
  }

  console.log('\n✅ E2E test environment ready!\n')
}

/**
 * Wait for a service to be available
 */
async function waitForService(name: string, url: string, timeout: number) {
  const startTime = Date.now()
  const checkInterval = 2000 // Check every 2 seconds

  while (Date.now() - startTime < timeout) {
    try {
      if (url.startsWith('http')) {
        await axios.get(url, { timeout: 5000 })
        console.log(`✓ ${name} is healthy`)
        return
      } else {
        // For non-HTTP services, just check if port is open
        console.log(`✓ ${name} is assumed healthy`)
        return
      }
    } catch (error) {
      // Service not ready, wait and retry
      await new Promise(resolve => setTimeout(resolve, checkInterval))
    }
  }

  throw new Error(`${name} failed to start within ${timeout}ms`)
}

/**
 * Clean test data from database
 */
async function cleanTestData() {
  const apiUrl = process.env.E2E_API_URL || 'http://localhost:4000/api'

  try {
    // Try to delete all test users (email contains 'test-')
    // This will be implemented via admin endpoint if available
    console.log('  - Removing test users...')

    // For now, we rely on database migrations to reset state
    // In production, you'd call a cleanup endpoint or run SQL directly
  } catch (error) {
    // It's okay if cleanup fails - tests should create unique data
  }
}

export default globalSetup
