import { create } from 'zustand'

interface AppState {
  sidebarOpen: boolean
  theme: 'light' | 'dark'
  notifications: Notification[]
  isLoading: boolean
  setSidebarOpen: (open: boolean) => void
  toggleSidebar: () => void
  setTheme: (theme: 'light' | 'dark') => void
  addNotification: (notification: Omit<Notification, 'id'>) => void
  removeNotification: (id: string) => void
  setLoading: (loading: boolean) => void
}

interface Notification {
  id: string
  title: string
  message?: string
  type: 'success' | 'error' | 'warning' | 'info'
  duration?: number
}

export const useAppStore = create<AppState>((set, get) => ({
  sidebarOpen: true,
  theme: 'light',
  notifications: [],
  isLoading: false,

  setSidebarOpen: (open: boolean) => {
    set({ sidebarOpen: open })
  },

  toggleSidebar: () => {
    set(state => ({ sidebarOpen: !state.sidebarOpen }))
  },

  setTheme: (theme: 'light' | 'dark') => {
    set({ theme })
    document.documentElement.classList.toggle('dark', theme === 'dark')
  },

  addNotification: (notification: Omit<Notification, 'id'>) => {
    const id = Math.random().toString(36).substr(2, 9)
    const newNotification = { ...notification, id }
    
    set(state => ({
      notifications: [...state.notifications, newNotification]
    }))

    // Auto-remove notification after duration (default 5s)
    const duration = notification.duration || 5000
    if (duration > 0) {
      setTimeout(() => {
        get().removeNotification(id)
      }, duration)
    }
  },

  removeNotification: (id: string) => {
    set(state => ({
      notifications: state.notifications.filter(n => n.id !== id)
    }))
  },

  setLoading: (loading: boolean) => {
    set({ isLoading: loading })
  },
}))

// Helper hook for notifications
export const useNotifications = () => {
  const { addNotification } = useAppStore()

  return {
    success: (title: string, message?: string) =>
      addNotification({ title, message, type: 'success' }),
    
    error: (title: string, message?: string) =>
      addNotification({ title, message, type: 'error', duration: 10000 }),
    
    warning: (title: string, message?: string) =>
      addNotification({ title, message, type: 'warning' }),
    
    info: (title: string, message?: string) =>
      addNotification({ title, message, type: 'info' }),
  }
}