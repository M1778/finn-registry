import { BrowserRouter, Routes, Route, Link } from 'react-router-dom'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import Home from './pages/Home'
import PackageDetail from './pages/PackageDetail'
import Docs from './pages/Docs'
import Explore from './pages/Explore'
import Account from './pages/Account'
import Login from './pages/Login'
import UserProfile from './pages/UserProfile'
import PublishPackage from './pages/PublishPackage'
import { Terminal, Github, BookOpen, LogIn } from 'lucide-react'
// Meaningfool comment
function Navbar() {
  const { user, isAuthenticated, isLoading } = useAuth()

  return (
    <nav className="border-b border-zinc-800 bg-[#09090b]/80 backdrop-blur-md sticky top-0 z-50">
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2 font-bold text-xl tracking-tight hover:text-white transition">
          <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white shadow-lg shadow-indigo-500/20">
            <Terminal size={18} />
          </div>
          Finn
        </Link>
        
        <div className="flex items-center gap-8 text-sm font-medium text-zinc-400">
          <Link to="/packages" className="hover:text-indigo-400 transition flex items-center gap-1.5">
            Explore
          </Link>
          <Link to="/docs" className="hover:text-indigo-400 transition flex items-center gap-1.5">
            <BookOpen size={16} /> Docs
          </Link>
          <div className="h-4 w-[1px] bg-zinc-800"></div>
          <a href="https://github.com/M1778M/finn" target="_blank" rel="noopener noreferrer" className="hover:text-white transition">
            <Github size={20} />
          </a>
          
          {isLoading ? (
            <div className="w-8 h-8 rounded-full bg-zinc-800 animate-pulse"></div>
          ) : isAuthenticated && user ? (
            <Link 
              to="/account" 
              className="flex items-center gap-2 hover:opacity-80 transition"
            >
              {user.avatar_url ? (
                <img 
                  src={user.avatar_url} 
                  alt={user.username}
                  className="w-8 h-8 rounded-full border-2 border-zinc-700 hover:border-indigo-500 transition"
                />
              ) : (
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-sm font-bold border-2 border-zinc-700 hover:border-indigo-500 transition">
                  {user.username.charAt(0).toUpperCase()}
                </div>
              )}
            </Link>
          ) : (
            <Link 
              to="/login" 
              className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-1.5 rounded-full transition flex items-center gap-2 shadow-lg shadow-indigo-500/20"
            >
              <LogIn size={16} /> Sign In
            </Link>
          )}
        </div>
      </div>
    </nav>
  )
}

function AppContent() {
  return (
    <div className="min-h-screen bg-[#09090b] text-[#e4e4e7] font-sans selection:bg-indigo-500/30">
      <Navbar />

      {/* Content */}
      <main className="max-w-6xl mx-auto px-6 py-12">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/packages" element={<Explore />} />
          <Route path="/packages/:name" element={<PackageDetail />} />
          <Route path="/publish" element={<PublishPackage />} />
          <Route path="/docs" element={<Docs />} />
          <Route path="/account" element={<Account />} />
          <Route path="/login" element={<Login />} />
          <Route path="/users/:username" element={<UserProfile />} />
        </Routes>
      </main>

      <footer className="border-t border-zinc-900 mt-20 py-12 text-center text-zinc-500 text-sm">
        <p>© 2025 Finn Language Ecosystem. Built for speed.</p>
      </footer>
    </div>
  )
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </BrowserRouter>
  )
}

export default App
