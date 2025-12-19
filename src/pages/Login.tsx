import { useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { Github, Terminal, AlertCircle, ArrowRight, Shield, Zap, Package } from 'lucide-react'

export default function Login() {
  const { isAuthenticated, isLoading, login } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const error = searchParams.get('error')

  useEffect(() => {
    if (isAuthenticated && !isLoading) {
      navigate('/account')
    }
  }, [isAuthenticated, isLoading, navigate])

  const getErrorMessage = (error: string | null) => {
    switch (error) {
      case 'oauth_failed':
        return 'OAuth authentication failed. Please try again.'
      case 'token_exchange_failed':
        return 'Failed to complete authentication with GitHub.'
      case 'github_api_failed':
        return 'Could not fetch your GitHub profile.'
      case 'user_creation_failed':
        return 'Failed to create your account. Please try again.'
      case 'oauth_error':
        return 'An unexpected error occurred during authentication.'
      case 'oauth_disabled_local':
        return 'GitHub OAuth is disabled in local development. Set up real GitHub OAuth credentials to enable authentication.'
      default:
        return null
    }
  }

  const errorMessage = getErrorMessage(error)

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500"></div>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[70vh]">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-indigo-600 rounded-2xl mb-4 shadow-lg shadow-indigo-500/30">
            <Terminal size={32} className="text-white" />
          </div>
          <h1 className="text-3xl font-bold mb-2">Sign in to Finn</h1>
          <p className="text-zinc-400">The package registry for the Fin language</p>
        </div>

        {/* Error Message */}
        {errorMessage && (
          <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-3">
            <AlertCircle size={20} className="text-red-400 shrink-0 mt-0.5" />
            <p className="text-red-400 text-sm">{errorMessage}</p>
          </div>
        )}

        {/* Login Card */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-8">
          <button
            onClick={login}
            className="w-full flex items-center justify-center gap-3 bg-gray-900 hover:bg-gray-800 border border-gray-700 text-white font-semibold py-3.5 px-6 rounded-xl transition-all duration-200 group shadow-lg hover:shadow-xl"
          >
            <Github size={22} className="text-gray-300 group-hover:text-white transition-colors" />
            Continue with GitHub
            <ArrowRight size={18} className="opacity-0 -ml-2 group-hover:opacity-100 group-hover:ml-0 transition-all duration-300" />
          </button>

          <div className="mt-6 pt-6 border-t border-zinc-800">
            <p className="text-xs text-zinc-500 text-center">
              By signing in, you agree to our Terms of Service and Privacy Policy.
            </p>
          </div>
        </div>

        {/* Features */}
        <div className="mt-8 grid grid-cols-3 gap-4">
          <div className="text-center">
            <div className="w-10 h-10 bg-indigo-500/10 rounded-xl flex items-center justify-center text-indigo-400 mx-auto mb-2">
              <Package size={20} />
            </div>
            <p className="text-xs text-zinc-500">Publish packages</p>
          </div>
          <div className="text-center">
            <div className="w-10 h-10 bg-green-500/10 rounded-xl flex items-center justify-center text-green-400 mx-auto mb-2">
              <Shield size={20} />
            </div>
            <p className="text-xs text-zinc-500">Secure API tokens</p>
          </div>
          <div className="text-center">
            <div className="w-10 h-10 bg-purple-500/10 rounded-xl flex items-center justify-center text-purple-400 mx-auto mb-2">
              <Zap size={20} />
            </div>
            <p className="text-xs text-zinc-500">CLI integration</p>
          </div>
        </div>

        {/* Alternative */}
        <p className="mt-8 text-center text-sm text-zinc-500">
          Just browsing?{' '}
          <a href="/packages" className="text-indigo-400 hover:underline">
            Explore packages
          </a>
        </p>
      </div>
    </div>
  )
}
