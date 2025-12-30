-- Users Table
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    github_id INTEGER UNIQUE NOT NULL,
    username TEXT NOT NULL,
    avatar_url TEXT NOT NULL,
    api_token TEXT UNIQUE NOT NULL, -- 32-char hex
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Packages Table
CREATE TABLE packages (
    id TEXT PRIMARY KEY, -- uuid or nanoid
    name TEXT UNIQUE NOT NULL,
    description TEXT NOT NULL,
    repo_url TEXT NOT NULL,
    homepage TEXT,
    keywords TEXT, -- JSON string array
    license TEXT NOT NULL,
    owner_id INTEGER NOT NULL,
    downloads INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_id) REFERENCES users(id)
);

-- Versions Table
CREATE TABLE versions (
    id TEXT PRIMARY KEY,
    package_id TEXT NOT NULL,
    version TEXT NOT NULL, -- SemVer
    commit_hash TEXT NOT NULL,
    readme_content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (package_id) REFERENCES packages(id),
    UNIQUE(package_id, version)
);
