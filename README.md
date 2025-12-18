# Finn Registry

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/M1778M/finn-registry)

The official package registry for the **Fin programming language**. A modern, fast, and secure platform for discovering, publishing, and managing Fin packages.

## ✨ Features

- 🚀 **Fast & Modern**: Built with React, TypeScript, and Cloudflare Workers
- 🔐 **Secure Authentication**: GitHub OAuth with session management
- 📦 **Package Management**: Full CRUD operations for Fin packages
- 📄 **TOML Validation**: Server-side parsing and validation of `finn.toml` files
- 📖 **README Rendering**: Automatic README fetching and caching from GitHub
- 📊 **Download Tracking**: Real-time download statistics and analytics
- 🎨 **Modern UI**: Polished interface with dark theme and smooth animations
- 🔍 **Search & Discovery**: Full-text search with filtering capabilities
- 🧪 **Comprehensive Testing**: 68+ tests covering all functionality

## 🏗️ Architecture

- **Frontend**: React + Vite + TypeScript + Tailwind CSS
- **Backend**: Hono framework on Cloudflare Workers
- **Database**: Cloudflare D1 (SQLite)
- **Authentication**: GitHub OAuth with httpOnly cookies
- **Deployment**: Cloudflare Pages with GitHub integration

## 🚀 Quick Start

### Prerequisites

- Node.js 20+
- GitHub account (for OAuth)
- Cloudflare account

### Local Development

1. **Clone the repository:**
   ```bash
   git clone https://github.com/M1778M/finn-registry.git
   cd finn-registry
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Set up environment:**
   ```bash
   cp .env.example .env.local
   # Edit .env.local with your GitHub OAuth credentials
   ```

4. **Set up database:**
   ```bash
   npm run db:migrate
   npm run db:migrate:remote  # For production
   ```

5. **Start development server:**
   ```bash
   npm run dev
   ```

6. **Add test data (optional):**
   ```bash
   npx wrangler d1 execute finn-db --file=./test-data.sql --local
   ```

### GitHub OAuth Setup

1. Create a GitHub OAuth App at [GitHub Developer Settings](https://github.com/settings/developers)
2. Set **Homepage URL** to your domain (e.g., `https://your-registry.com`)
3. Set **Authorization callback URL** to `https://your-registry.com/api/auth/callback`
4. Add the Client ID and Secret to Cloudflare:
   ```bash
   wrangler secret put GITHUB_CLIENT_ID
   wrangler secret put GITHUB_CLIENT_SECRET
   ```

### Deployment

#### Frontend (Cloudflare Pages)
The project is configured for automatic deployment via Cloudflare Pages:

1. Connect this GitHub repo to Cloudflare Pages
2. Set project name to `registry` (for URL: `https://registry.fin-lang.workers.dev`)
3. Set build command: `npm run build`
4. Set build output: `dist`
5. Deploy!

#### Backend (Cloudflare Workers)
Deploy the worker manually through Cloudflare Workers dashboard:

1. Go to [Cloudflare Workers](https://dash.cloudflare.com/workers-and-pages)
2. Create new Worker
3. Copy the built worker code from `dist/worker.js`
4. Set environment variables:
   - `GITHUB_CLIENT_ID`
   - `GITHUB_CLIENT_SECRET`
   - `APP_URL` = `https://registry.fin-lang.workers.dev`
   - `finn_db` = Your D1 database ID

5. Set up routing to proxy API calls (`/api/*`) to your worker

## 📦 Package Publishing

### For Package Authors

1. **Create a `finn.toml` file** in your repository:
   ```toml
   [project]
   name = "my_package"
   version = "1.0.0"
   entrypoint = "lib.fin"
   description = "A useful Fin package"
   repository = "https://github.com/username/my_package"
   license = "MIT"

   [packages]
   std = "std"
   ```

2. **Publish via the web interface:**
   - Sign in with GitHub
   - Go to Account → Publish Version
   - Upload your `finn.toml` file
   - Add version details and changelog

3. **Publish via CLI** (future feature):
   ```bash
   finn publish
   ```

### Package Structure Requirements

- **Name**: Lowercase alphanumeric + underscores/dashes
- **Version**: Strict semantic versioning (X.Y.Z)
- **Entrypoint**: `lib.fin` (library) or `main.fin` (binary)
- **Repository**: Must be a valid GitHub URL
- **README**: Optional but recommended in repository root

## 🧪 Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run with UI
npm run test:ui

# Type checking
npm run typecheck

# Linting
npm run lint
```

## 📊 API Endpoints

### Authentication
- `GET /api/auth/github` - Initiate GitHub OAuth
- `GET /api/auth/callback` - OAuth callback
- `GET /api/auth/me` - Get current user
- `POST /api/auth/logout` - Logout
- `POST /api/auth/token/regenerate` - Regenerate API token

### Packages
- `GET /api/packages` - List all packages
- `GET /api/packages/:name` - Get package details
- `POST /api/packages` - Create package
- `POST /api/packages/:name/versions` - Publish version
- `DELETE /api/packages/:name` - Delete package

### Search & Discovery
- `GET /api/search` - Search packages
- `GET /api/stats` - Registry statistics

### Documentation
- `GET /api/packages/:name/readme` - Get package README
- `GET /api/users/:username` - Get user profile

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Commit your changes: `git commit -m 'Add amazing feature'`
4. Push to the branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [Fin Programming Language](https://github.com/fin-lang/fin)
- [Cloudflare Workers](https://workers.cloudflare.com/)
- [Hono Framework](https://hono.dev/)
- [React](https://reactjs.org/)

---

Built with ❤️ for the Fin community
