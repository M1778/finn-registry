import { useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { User, Key, Package, Copy, Check, Eye, EyeOff, Github, LogOut, Settings, Shield, Clock, ExternalLink, RefreshCw, AlertTriangle } from 'lucide-react'

export default function Account() {
  const { user, packages, isLoading, isAuthenticated, logout, regenerateToken } = useAuth()
  const [showToken, setShowToken] = useState(false)
  const [copied, setCopied] = useState(false)
  const [isRegenerating, setIsRegenerating] = useState(false)
  const [showRegenerateConfirm, setShowRegenerateConfirm] = useState(false)
  const [publishModal, setPublishModal] = useState<{ open: boolean; packageName: string }>({ open: false, packageName: '' })
  const [publishForm, setPublishForm] = useState({
    version: '',
    commit_hash: '',
    finn_toml_content: '',
    changelog: ''
  })
  const [isPublishing, setIsPublishing] = useState(false)

  // Redirect to login if not authenticated
  if (!isLoading && !isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  if (isLoading || !user) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500"></div>
      </div>
    )
  }

  const copyToken = () => {
    navigator.clipboard.writeText(user.api_token)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const maskToken = (token: string) => {
    return token.slice(0, 12) + '•'.repeat(24)
  }

  const formatDate = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleDateString('en-US', { 
      month: 'long', 
      day: 'numeric', 
      year: 'numeric' 
    })
  }

  const handleRegenerateToken = async () => {
    setIsRegenerating(true)
    await regenerateToken()
    setIsRegenerating(false)
    setShowRegenerateConfirm(false)
  }

  const handlePublishVersion = async () => {
    if (!publishForm.version || !publishForm.finn_toml_content) return

    setIsPublishing(true)
    try {
      const response = await fetch(`/api/packages/${publishModal.packageName}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(publishForm)
      })

      if (response.ok) {
        setPublishModal({ open: false, packageName: '' })
        setPublishForm({ version: '', commit_hash: '', finn_toml_content: '', changelog: '' })
        // Refresh packages
        window.location.reload()
      } else {
        const error = await response.json()
        alert(error.error || 'Failed to publish version')
      }
    } catch {
      alert('Network error')
    }
    setIsPublishing(false)
  }

  return (
    <div className="max-w-4xl mx-auto animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex items-center justify-between mb-10">
        <div className="flex items-center gap-4">
          {user.avatar_url ? (
            <img 
              src={user.avatar_url} 
              alt={user.username}
              className="w-16 h-16 rounded-2xl shadow-lg"
            />
          ) : (
            <div className="w-16 h-16 bg-zinc-700 rounded-lg flex items-center justify-center text-white text-2xl font-bold">
              {user.username.charAt(0).toUpperCase()}
            </div>
          )}
          <div>
            <h1 className="text-3xl font-bold">{user.username}</h1>
            <p className="text-zinc-400 flex items-center gap-2">
              <Github size={16} />
              Connected via GitHub
            </p>
          </div>
        </div>
        <button 
          onClick={logout}
          className="flex items-center gap-2 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg transition text-zinc-300"
        >
          <LogOut size={18} />
          Sign Out
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-8">
          {/* API Token Section */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 bg-amber-500/10 rounded-xl flex items-center justify-center text-amber-400">
                <Key size={20} />
              </div>
              <div>
                <h2 className="text-xl font-bold">API Token</h2>
                <p className="text-sm text-zinc-500">Use this token to authenticate the Finn CLI</p>
              </div>
            </div>

            <div className="bg-black border border-zinc-800 rounded-xl p-4 mb-4">
              <div className="flex items-center justify-between gap-4">
                <code className="text-sm font-mono text-indigo-400 flex-1 overflow-hidden">
                  {showToken ? user.api_token : maskToken(user.api_token)}
                </code>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowToken(!showToken)}
                    className="p-2 hover:bg-zinc-800 rounded-lg transition"
                    title={showToken ? 'Hide token' : 'Show token'}
                  >
                    {showToken ? <EyeOff size={18} className="text-zinc-500" /> : <Eye size={18} className="text-zinc-500" />}
                  </button>
                  <button
                    onClick={copyToken}
                    className="p-2 hover:bg-zinc-800 rounded-lg transition"
                    title="Copy token"
                  >
                    {copied ? <Check size={18} className="text-green-500" /> : <Copy size={18} className="text-zinc-500" />}
                  </button>
                </div>
              </div>
            </div>

            <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-4">
              <p className="text-sm text-amber-400 flex items-start gap-2">
                <Shield size={16} className="shrink-0 mt-0.5" />
                <span>Keep this token secret! Anyone with access can publish packages under your account.</span>
              </p>
            </div>

            <div className="mt-6">
              <h3 className="text-sm font-bold text-zinc-500 uppercase tracking-widest mb-3">Usage</h3>
              <div className="bg-black border border-zinc-800 rounded-lg p-4">
                <code className="text-sm font-mono text-zinc-400">
                  <span className="text-indigo-400">$</span> finn login<br />
                  <span className="text-zinc-600"># Paste your token when prompted</span>
                </code>
              </div>
            </div>
          </div>

          {/* Owned Packages */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-indigo-500/10 rounded-xl flex items-center justify-center text-indigo-400">
                  <Package size={20} />
                </div>
                <div>
                  <h2 className="text-xl font-bold">Your Packages</h2>
                  <p className="text-sm text-zinc-500">{packages.length} packages published</p>
                </div>
              </div>
              <Link 
                to="/docs" 
                className="text-sm text-indigo-400 hover:underline flex items-center gap-1"
              >
                Publish a package <ExternalLink size={14} />
              </Link>
            </div>

            {packages.length === 0 ? (
              <div className="text-center py-8 text-zinc-500">
                <Package size={40} className="mx-auto mb-3 opacity-50" />
                <p>You haven't published any packages yet.</p>
                <Link to="/docs" className="text-indigo-400 hover:underline text-sm mt-2 inline-block">
                  Learn how to publish →
                </Link>
              </div>
            ) : (
              <div className="space-y-4">
                {packages.map(pkg => (
                  <Link
                    key={pkg.name}
                    to={`/packages/${pkg.name}`}
                    className="flex items-center justify-between p-4 bg-black/50 border border-zinc-800 rounded-xl hover:border-indigo-500/50 transition group"
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 bg-zinc-800 rounded-lg flex items-center justify-center text-indigo-400 group-hover:bg-indigo-500/20 transition">
                        <Package size={20} />
                      </div>
                      <div>
                        <h3 className="font-bold group-hover:text-indigo-400 transition">{pkg.name}</h3>
                        <p className="text-sm text-zinc-500">{pkg.description}</p>
                      </div>
                    </div>
                     <div className="flex items-center gap-2">
                       <div className="text-right">
                         <p className="font-mono text-sm">{pkg.downloads.toLocaleString()}</p>
                         <p className="text-xs text-zinc-500">downloads</p>
                       </div>
                       <button
                         onClick={(e) => {
                           e.preventDefault()
                           setPublishModal({ open: true, packageName: pkg.name })
                         }}
                         className="px-3 py-1 bg-zinc-700 hover:bg-zinc-600 text-white text-xs rounded transition"
                       >
                         Publish Version
                       </button>
                     </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Account Info */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
            <h3 className="text-sm font-bold text-zinc-500 uppercase tracking-widest mb-4">Account Info</h3>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-zinc-500 flex items-center gap-2">
                  <User size={16} />
                  Username
                </span>
                <span className="font-mono">{user.username}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-500 flex items-center gap-2">
                  <Clock size={16} />
                  Member since
                </span>
                <span className="text-sm">{formatDate(user.created_at)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-500 flex items-center gap-2">
                  <Package size={16} />
                  Packages
                </span>
                <span className="font-mono">{packages.length}</span>
              </div>
            </div>
          </div>

          {/* Quick Actions */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
            <h3 className="text-sm font-bold text-zinc-500 uppercase tracking-widest mb-4">Quick Actions</h3>
            <div className="space-y-2">
              <button className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-800 rounded-lg transition text-zinc-300">
                <Settings size={18} />
                Account Settings
              </button>
              <button 
                onClick={() => setShowRegenerateConfirm(true)}
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-800 rounded-lg transition text-zinc-300"
              >
                <Key size={18} />
                Regenerate Token
              </button>
              <Link 
                to="/docs"
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-800 rounded-lg transition text-zinc-300"
              >
                <Package size={18} />
                Publish New Package
              </Link>
            </div>
          </div>

          {/* Help Box */}
          <div className="bg-gradient-to-br from-indigo-500/10 to-purple-500/10 border border-indigo-500/20 rounded-2xl p-6">
            <h3 className="font-bold mb-2">Need Help?</h3>
            <p className="text-sm text-zinc-400 mb-4">
              Check out our documentation for guides on publishing and managing packages.
            </p>
            <Link 
              to="/docs"
              className="text-indigo-400 hover:underline text-sm flex items-center gap-1"
            >
              View Documentation <ExternalLink size={14} />
            </Link>
          </div>
        </div>
      </div>

      {/* Publish Version Modal */}
      {publishModal.open && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-xl font-bold mb-4">Publish Version for {publishModal.packageName}</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Version *</label>
                <input
                  type="text"
                  value={publishForm.version}
                  onChange={(e) => setPublishForm({ ...publishForm, version: e.target.value })}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-white"
                  placeholder="1.0.0"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Commit Hash</label>
                <input
                  type="text"
                  value={publishForm.commit_hash}
                  onChange={(e) => setPublishForm({ ...publishForm, commit_hash: e.target.value })}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-white"
                  placeholder="abc123..."
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Finn TOML Content *</label>
                <textarea
                  value={publishForm.finn_toml_content}
                  onChange={(e) => setPublishForm({ ...publishForm, finn_toml_content: e.target.value })}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-white h-32"
                  placeholder="[project]&#10;name = ...&#10;version = ...&#10;..."
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Changelog</label>
                <textarea
                  value={publishForm.changelog}
                  onChange={(e) => setPublishForm({ ...publishForm, changelog: e.target.value })}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-white h-20"
                  placeholder="What's new in this version..."
                />
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setPublishModal({ open: false, packageName: '' })}
                className="flex-1 px-4 py-2 bg-zinc-700 hover:bg-zinc-600 rounded transition"
              >
                Cancel
              </button>
              <button
                onClick={handlePublishVersion}
                disabled={isPublishing}
                className="flex-1 px-4 py-2 bg-white text-black rounded transition flex items-center justify-center gap-2"
              >
                {isPublishing ? 'Publishing...' : 'Publish'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Regenerate Token Confirmation Modal */}
      {showRegenerateConfirm && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 max-w-md w-full mx-4 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-amber-500/10 rounded-xl flex items-center justify-center text-amber-400">
                <AlertTriangle size={20} />
              </div>
              <h3 className="text-xl font-bold">Regenerate API Token?</h3>
            </div>
            <p className="text-zinc-400 mb-6">
              This will invalidate your current token. Any CLI sessions or integrations using the old token will stop working.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowRegenerateConfirm(false)}
                className="flex-1 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg transition"
              >
                Cancel
              </button>
              <button
                onClick={handleRegenerateToken}
                disabled={isRegenerating}
                className="flex-1 px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition flex items-center justify-center gap-2"
              >
                {isRegenerating ? (
                  <RefreshCw size={18} className="animate-spin" />
                ) : (
                  <>
                    <RefreshCw size={18} />
                    Regenerate
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
