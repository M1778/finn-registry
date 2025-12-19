import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { cors } from 'hono/cors';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import * as TOML from '@iarna/toml';

// Types
type Bindings = {
  finn_db: D1Database;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  APP_URL: string;
};

type Variables = {
  user: User | null;
};

type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>;

interface User {
  id: number;
  username: string;
  github_id: number;
  avatar_url: string | null;
  email: string | null;
  api_token: string;
  created_at: number;
}

interface GitHubUser {
  id: number;
  login: string;
  avatar_url: string;
  email: string | null;
}

interface FinnToml {
  project: {
    name: string;
    version: string;
    entrypoint?: string;
    description?: string;
    repository?: string;
    license?: string;
  };
  packages?: Record<string, string>;
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Enable CORS
app.use('/api/*', cors({
  origin: (origin) => origin || '*',
  credentials: true,
}));

// --- UTILITY FUNCTIONS ---

function generateToken(length: number = 32): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const randomValues = new Uint8Array(length);
  crypto.getRandomValues(randomValues);
  for (let i = 0; i < length; i++) {
    result += chars[randomValues[i] % chars.length];
  }
  return result;
}

function generateSessionId(): string {
  return `sess_${generateToken(32)}`;
}

function generateApiToken(): string {
  return `finn_tok_${generateToken(32)}`;
}

// --- AUTH MIDDLEWARE ---

const authMiddleware = async (c: AppContext, next: Next) => {
  const sessionId = getCookie(c, 'finn_session');
  
  if (!sessionId) {
    c.set('user', null);
    return next();
  }

  try {
    const session = await c.env.finn_db.prepare(
      "SELECT user_id, expires_at FROM sessions WHERE id = ?"
    ).bind(sessionId).first<{ user_id: number; expires_at: number }>();

    if (!session || session.expires_at < Math.floor(Date.now() / 1000)) {
      // Session expired or not found
      deleteCookie(c, 'finn_session');
      c.set('user', null);
      return next();
    }

    const user = await c.env.finn_db.prepare(
      "SELECT id, username, github_id, avatar_url, email, api_token, created_at FROM users WHERE id = ?"
    ).bind(session.user_id).first<User>();

    c.set('user', user || null);
  } catch {
    c.set('user', null);
  }

  return next();
};

// Require authentication middleware
const requireAuth = async (c: AppContext, next: Next) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Authentication required' }, 401);
  }
  return next();
};

// Apply auth middleware to all API routes
app.use('/api/*', authMiddleware);

// --- AUTH ROUTES ---

// Initiate GitHub OAuth
app.get('/api/auth/github', async (c) => {
  const clientId = c.env.GITHUB_CLIENT_ID;
  const redirectUri = `${c.env.APP_URL}/api/auth/callback`;

  console.log('OAuth Debug:', { clientId, redirectUri, appUrl: c.env.APP_URL });

  // For local development with dummy credentials, redirect to login with error
  if (clientId === 'dummy_client_id' || !clientId) {
    console.log('Using dummy OAuth credentials - redirecting to login with error');
    return c.redirect('/?error=oauth_disabled_local');
  }

  const state = generateToken(16);

  // Store state in cookie for CSRF protection
  setCookie(c, 'oauth_state', state, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    maxAge: 600, // 10 minutes
    path: '/',
  });

  const authUrl = new URL('https://github.com/login/oauth/authorize');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', 'user:email');
  authUrl.searchParams.set('state', state);

  console.log('Redirecting to GitHub OAuth:', authUrl.toString());
  return c.redirect(authUrl.toString());
});

// GitHub OAuth callback
app.get('/api/auth/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const storedState = getCookie(c, 'oauth_state');

  // Clear the state cookie
  deleteCookie(c, 'oauth_state');

  if (!code || !state || state !== storedState) {
    return c.redirect('/?error=oauth_failed');
  }

  try {
    // Exchange code for access token
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: c.env.GITHUB_CLIENT_ID,
        client_secret: c.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${c.env.APP_URL}/api/auth/callback`,
      }),
    });

    const tokenData = await tokenResponse.json() as { access_token?: string; error?: string };

    if (!tokenData.access_token) {
      console.error('Token exchange failed:', tokenData);
      return c.redirect('/?error=token_exchange_failed');
    }

    // Fetch GitHub user info
    const userResponse = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
        'User-Agent': 'Finn-Registry',
        'Accept': 'application/vnd.github.v3+json',
      },
    });

    if (!userResponse.ok) {
      return c.redirect('/?error=github_api_failed');
    }

    const githubUser = await userResponse.json() as GitHubUser;

    // Check if user exists, create or update
    let user = await c.env.finn_db.prepare(
      "SELECT * FROM users WHERE github_id = ?"
    ).bind(githubUser.id).first<User>();

    if (user) {
      // Update existing user
      await c.env.finn_db.prepare(
        "UPDATE users SET username = ?, avatar_url = ?, email = ? WHERE github_id = ?"
      ).bind(githubUser.login, githubUser.avatar_url, githubUser.email, githubUser.id).run();
    } else {
      // Create new user with API token
      const apiToken = generateApiToken();
      await c.env.finn_db.prepare(
        "INSERT INTO users (username, github_id, avatar_url, email, api_token) VALUES (?, ?, ?, ?, ?)"
      ).bind(githubUser.login, githubUser.id, githubUser.avatar_url, githubUser.email, apiToken).run();
      
      user = await c.env.finn_db.prepare(
        "SELECT * FROM users WHERE github_id = ?"
      ).bind(githubUser.id).first<User>();
    }

    if (!user) {
      return c.redirect('/?error=user_creation_failed');
    }

    // Create session with metadata
    const sessionId = generateSessionId();
    const expiresAt = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60); // 30 days
    const userAgent = c.req.header('User-Agent') || 'Unknown';
    const ipAddress = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'Unknown';
    const loginTime = Math.floor(Date.now() / 1000);

    await c.env.finn_db.prepare(
      "INSERT INTO sessions (id, user_id, expires_at, user_agent, ip_address, login_time) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(sessionId, user.id, expiresAt, userAgent, ipAddress, loginTime).run();

    // Set session cookie
    setCookie(c, 'finn_session', sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 30 * 24 * 60 * 60, // 30 days
      path: '/',
    });

    return c.redirect('/account');
  } catch (error) {
    console.error('OAuth error:', error);
    return c.redirect('/?error=oauth_error');
  }
});

// Get current user
app.get('/api/auth/me', async (c) => {
  const user = c.get('user');
  
  if (!user) {
    return c.json({ user: null });
  }

  // Get user's packages
  const { results: packages } = await c.env.finn_db.prepare(
    "SELECT name, description, downloads, created_at FROM packages WHERE owner_id = ? ORDER BY downloads DESC"
  ).bind(user.id).all();

  return c.json({
    user: {
      id: user.id,
      username: user.username,
      avatar_url: user.avatar_url,
      email: user.email,
      api_token: user.api_token,
      created_at: user.created_at,
    },
    packages: packages || [],
  });
});

// Logout
app.post('/api/auth/logout', async (c) => {
  const sessionId = getCookie(c, 'finn_session');
  
  if (sessionId) {
    // Delete session from database
    await c.env.finn_db.prepare(
      "DELETE FROM sessions WHERE id = ?"
    ).bind(sessionId).run();
    
    deleteCookie(c, 'finn_session');
  }

  return c.json({ success: true });
});

// Regenerate API token
app.post('/api/auth/token/regenerate', requireAuth, async (c) => {
  const user = c.get('user')!;
  const newToken = generateApiToken();

  await c.env.finn_db.prepare(
    "UPDATE users SET api_token = ? WHERE id = ?"
  ).bind(newToken, user.id).run();

  return c.json({ api_token: newToken });
});

// --- PACKAGE ROUTES ---

// 1. Search Packages
app.get('/api/search', async (c) => {
  const query = c.req.query('q') || '';
  
  try {
    const { results } = await c.env.finn_db.prepare(
      "SELECT name, description, downloads, keywords, license, created_at FROM packages WHERE name LIKE ? OR description LIKE ? ORDER BY downloads DESC LIMIT 10"
    )
    .bind(`%${query}%`, `%${query}%`)
    .all();

    return c.json(results || []);
  } catch (e) {
    // Return empty array if table doesn't exist yet
    console.error('Search error:', e);
    return c.json([]);
  }
});

// 2. List All Packages
app.get('/api/packages', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');
  
  try {
    const { results } = await c.env.finn_db.prepare(
      "SELECT p.*, u.username as owner_name FROM packages p LEFT JOIN users u ON p.owner_id = u.id ORDER BY p.downloads DESC LIMIT ? OFFSET ?"
    ).bind(limit, offset).all();

    const countResult = await c.env.finn_db.prepare(
      "SELECT COUNT(*) as total FROM packages"
    ).first<{ total: number }>();

    return c.json({
      packages: results || [],
      total: countResult?.total || 0,
      limit,
      offset,
    });
  } catch (e) {
    // Return empty response if table doesn't exist yet
    console.error('List packages error:', e);
    return c.json({
      packages: [],
      total: 0,
      limit,
      offset,
    });
  }
});

// 3. Get Package Details
app.get('/api/packages/:name', async (c) => {
  const name = c.req.param('name');

  try {
    const pkg = await c.env.finn_db.prepare(
      "SELECT p.*, u.username as owner_name, u.avatar_url as owner_avatar FROM packages p LEFT JOIN users u ON p.owner_id = u.id WHERE p.name = ?"
    )
    .bind(name)
    .first();

    if (!pkg) {
      return c.json({ error: 'Package not found' }, 404);
    }

    // Get versions
    const { results: versions } = await c.env.finn_db.prepare(
      "SELECT version, commit_hash, created_at FROM versions WHERE package_name = ? ORDER BY created_at DESC"
    ).bind(name).all();

    // Increment downloads in the background
    c.executionCtx.waitUntil(
      (async () => {
        // Update total downloads
        await c.env.finn_db.prepare("UPDATE packages SET downloads = downloads + 1 WHERE name = ?")
          .bind(name)
          .run();

        // Update daily stats
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        await c.env.finn_db.prepare(
          "INSERT INTO download_stats (package_name, date, count) VALUES (?, ?, 1) ON CONFLICT(package_name, date) DO UPDATE SET count = count + 1"
        ).bind(name, today).run();
      })()
    );

    return c.json({ ...pkg, versions: versions || [] });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// 3b. Get Package README (with caching)
app.get('/api/packages/:name/readme', async (c) => {
  const name = c.req.param('name');

  try {
    const pkg = await c.env.finn_db.prepare(
      "SELECT repo_url FROM packages WHERE name = ?"
    ).bind(name).first<{ repo_url: string }>();

    if (!pkg) {
      return c.json({ error: 'Package not found' }, 404);
    }

    // Check cache first (TTL: 24 hours)
    const cached = await c.env.finn_db.prepare(
      "SELECT content, updated_at FROM package_readme_cache WHERE package_name = ?"
    ).bind(name).first<{ content: string; updated_at: number }>();

    const now = Math.floor(Date.now() / 1000);
    const cacheExpiry = 24 * 60 * 60; // 24 hours

    if (cached && (now - cached.updated_at) < cacheExpiry) {
      return c.json({ readme: cached.content });
    }

    // Fetch from GitHub
    const match = pkg.repo_url.match(/github\.com\/([^/]+)\/([^/]+?)(\.git)?$/);
    if (!match) {
      return c.json({ readme: null, error: 'Not a GitHub repository' });
    }

    const [, owner, repo] = match;
    const readmeUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/README.md`;

    let content: string;
    try {
      const response = await fetch(readmeUrl);
      if (!response.ok) {
        // Try master branch
        const masterUrl = `https://raw.githubusercontent.com/${owner}/${repo}/master/README.md`;
        const masterResponse = await fetch(masterUrl);
        if (!masterResponse.ok) {
          return c.json({ readme: null, error: 'README not found' });
        }
        content = await masterResponse.text();
      } else {
        content = await response.text();
      }
    } catch {
      return c.json({ readme: null, error: 'Failed to fetch README' });
    }

    // Cache the content
    await c.env.finn_db.prepare(
      "INSERT OR REPLACE INTO package_readme_cache (package_name, content, updated_at) VALUES (?, ?, ?)"
    ).bind(name, content, now).run();

    return c.json({ readme: content });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// 4. Create Package (Protected)
app.post('/api/packages', requireAuth, async (c) => {
  const user = c.get('user')!;
  
  try {
    const body = await c.req.json();
    const { name, description, repo_url, keywords, license, homepage } = body as {
      name: string;
      description?: string;
      repo_url: string;
      keywords?: string[];
      license?: string;
      homepage?: string;
    };

    if (!name || !repo_url) {
      return c.json({ error: 'Missing required fields: name, repo_url' }, 400);
    }

    // Validate package name
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      return c.json({ error: 'Invalid package name. Use lowercase letters, numbers, and hyphens only.' }, 400);
    }

    // Check if package already exists
    const existing = await c.env.finn_db.prepare(
      "SELECT owner_id FROM packages WHERE name = ?"
    ).bind(name).first<{ owner_id: number }>();

    if (existing) {
      // Check ownership
      if (existing.owner_id !== user.id) {
        return c.json({ error: 'Package already exists and you are not the owner' }, 403);
      }
      
      // Update existing package
      await c.env.finn_db.prepare(
        "UPDATE packages SET description = ?, repo_url = ?, keywords = ?, license = ?, homepage = ?, updated_at = ? WHERE name = ?"
      ).bind(
        description || null,
        repo_url,
        keywords ? JSON.stringify(keywords) : null,
        license || 'MIT',
        homepage || null,
        Math.floor(Date.now() / 1000),
        name
      ).run();
    } else {
      // Create new package
      await c.env.finn_db.prepare(
        "INSERT INTO packages (name, description, repo_url, keywords, license, homepage, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        name,
        description || null,
        repo_url,
        keywords ? JSON.stringify(keywords) : null,
        license || 'MIT',
        homepage || null,
        user.id
      ).run();
    }

    return c.json({ success: true, name });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// 5. Delete Package (Protected)
app.delete('/api/packages/:name', requireAuth, async (c) => {
  const user = c.get('user')!;
  const name = c.req.param('name');

  try {
    const pkg = await c.env.finn_db.prepare(
      "SELECT owner_id FROM packages WHERE name = ?"
    ).bind(name).first<{ owner_id: number }>();

    if (!pkg) {
      return c.json({ error: 'Package not found' }, 404);
    }

    if (pkg.owner_id !== user.id) {
      return c.json({ error: 'You are not the owner of this package' }, 403);
    }

    await c.env.finn_db.prepare(
      "DELETE FROM packages WHERE name = ?"
    ).bind(name).run();

    return c.json({ success: true });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// 6. Create Version (Protected)
app.post('/api/packages/:name/versions', requireAuth, async (c) => {
  const user = c.get('user')!;
  const packageName = c.req.param('name');

  try {
    // Check package ownership
    const pkg = await c.env.finn_db.prepare(
      "SELECT owner_id, repo_url FROM packages WHERE name = ?"
    ).bind(packageName).first<{ owner_id: number; repo_url: string }>();

    if (!pkg) {
      return c.json({ error: 'Package not found' }, 404);
    }

    if (pkg.owner_id !== user.id) {
      return c.json({ error: 'You are not the owner of this package' }, 403);
    }

    const body = await c.req.json();
    const { version, commit_hash, changelog, finn_toml_content } = body as {
      version: string;
      commit_hash?: string;
      changelog?: string;
      finn_toml_content: string;
    };

    if (!version || !finn_toml_content) {
      return c.json({ error: 'Missing required fields: version, finn_toml_content' }, 400);
    }

    // Parse TOML content
    let tomlData: FinnToml;
    try {
      tomlData = TOML.parse(finn_toml_content) as unknown as FinnToml;
    } catch {
      return c.json({ error: 'Invalid TOML format in finn_toml_content' }, 400);
    }

    // Validate TOML structure
    if (!tomlData.project || !tomlData.project.name || !tomlData.project.version) {
      return c.json({ error: 'TOML must contain [project] section with name and version' }, 400);
    }

    // Validate name matches URL param
    if (tomlData.project.name !== packageName) {
      return c.json({ error: 'Package name in TOML does not match URL parameter' }, 400);
    }

    // Validate version matches payload
    if (tomlData.project.version !== version) {
      return c.json({ error: 'Version in TOML does not match payload version' }, 400);
    }

    // Validate semver format
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
      return c.json({ error: 'Invalid version format. Use semantic versioning (e.g., 1.0.0)' }, 400);
    }

    // Check if version exists
    const existingVersion = await c.env.finn_db.prepare(
      "SELECT version FROM versions WHERE package_name = ? AND version = ?"
    ).bind(packageName, version).first();

    if (existingVersion) {
      return c.json({ error: 'Version already exists' }, 409);
    }

    // Insert version
    await c.env.finn_db.prepare(
      "INSERT INTO versions (package_name, version, commit_hash, changelog) VALUES (?, ?, ?, ?)"
    ).bind(packageName, version, commit_hash || null, changelog || null).run();

    // Update package metadata from TOML
    const description = tomlData.project.description || null;
    const repo_url = tomlData.project.repository || pkg.repo_url; // Keep existing if not provided
    const license = tomlData.project.license || 'MIT';

    await c.env.finn_db.prepare(
      "UPDATE packages SET description = ?, repo_url = ?, license = ?, updated_at = ? WHERE name = ?"
    ).bind(description, repo_url, license, Math.floor(Date.now() / 1000), packageName).run();

    return c.json({ success: true, package_name: packageName, version });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// 7. Get Package Versions
app.get('/api/packages/:name/versions', async (c) => {
  const name = c.req.param('name');

  try {
    const { results } = await c.env.finn_db.prepare(
      "SELECT version, commit_hash, changelog, created_at FROM versions WHERE package_name = ? ORDER BY created_at DESC"
    )
    .bind(name)
    .all();

    return c.json(results || []);
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// 8. Get User Profile
app.get('/api/users/:username', async (c) => {
  const username = c.req.param('username');

  try {
    const user = await c.env.finn_db.prepare(
      "SELECT id, username, avatar_url, created_at FROM users WHERE username = ?"
    )
    .bind(username)
    .first();

    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    const { results: packages } = await c.env.finn_db.prepare(
      "SELECT name, description, downloads, created_at FROM packages WHERE owner_id = ? ORDER BY downloads DESC"
    ).bind((user as { id: number }).id).all();

    return c.json({ ...user, packages: packages || [] });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// 9. CLI Authentication (API Token)
app.post('/api/cli/auth', async (c) => {
  try {
    const body = await c.req.json();
    const { api_token } = body as { api_token: string };

    if (!api_token) {
      return c.json({ error: 'Missing api_token' }, 400);
    }

    const user = await c.env.finn_db.prepare(
      "SELECT id, username, avatar_url FROM users WHERE api_token = ?"
    ).bind(api_token).first();

    if (!user) {
      return c.json({ error: 'Invalid API token' }, 401);
    }

    return c.json({ authenticated: true, user });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// 10. Health check
app.get('/api/health', (c) => {
  return c.json({ status: 'ok', timestamp: Date.now() });
});

// 11. Stats endpoint
app.get('/api/stats', async (c) => {
  try {
    const packageCount = await c.env.finn_db.prepare(
      "SELECT COUNT(*) as count FROM packages"
    ).first<{ count: number }>();

    const userCount = await c.env.finn_db.prepare(
      "SELECT COUNT(*) as count FROM users"
    ).first<{ count: number }>();

    const totalDownloads = await c.env.finn_db.prepare(
      "SELECT SUM(downloads) as total FROM packages"
    ).first<{ total: number }>();

    return c.json({
      packages: packageCount?.count || 0,
      users: userCount?.count || 0,
      downloads: totalDownloads?.total || 0,
    });
  } catch (e) {
    // Return zeros if tables don't exist yet
    console.error('Stats error:', e);
    return c.json({
      packages: 0,
      users: 0,
      downloads: 0,
    });
  }
});

export default app;
