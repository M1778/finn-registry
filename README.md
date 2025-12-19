# Finn Registry

Finn Registry is the official package registry for the Fin programming language, providing a centralized platform for discovering, publishing, and managing Fin packages.

## Overview

The Finn Registry serves as a comprehensive ecosystem for Fin developers to:

- **Discover packages** through an intuitive web interface and search functionality
- **Publish packages** with automated validation and version management
- **Access documentation** with integrated README rendering and package details
- **Track analytics** including download statistics and package popularity
- **Collaborate** through GitHub-based authentication and user profiles

## How It Works

### The Fin Package Ecosystem

Fin is a modern systems programming language designed for performance and safety. The package ecosystem consists of:

1. **Packages**: Reusable code libraries distributed via the registry
2. **Manifest Files**: `finn.toml` files that define package metadata, dependencies, and configuration
3. **Registry**: Centralized database of all published packages with version history
4. **CLI Tool**: `finn` command-line tool for package management (separate from this web registry)

### Package Publishing Workflow

1. **Author creates package** with proper `finn.toml` manifest
2. **Upload to registry** through web interface or future CLI integration
3. **Automatic validation** of manifest format and version semantics
4. **Version management** with semantic versioning support
5. **Documentation integration** from GitHub repository README files

### User Authentication

The registry uses GitHub OAuth for secure authentication, providing:

- **Identity verification** through GitHub accounts
- **Package ownership** linked to GitHub users
- **API token management** for CLI tool integration
- **Session management** with automatic expiration

## API Reference

### Authentication Endpoints

#### `GET /api/auth/github`
Initiates GitHub OAuth login flow.

**Response**: Redirects to GitHub authorization page.

#### `GET /api/auth/callback`
Handles OAuth callback from GitHub.

**Query Parameters**:
- `code`: Authorization code from GitHub
- `state`: CSRF protection token

**Response**: Redirects to dashboard on success, or login page with error.

#### `GET /api/auth/me`
Retrieves current user information.

**Authentication**: Required (session cookie)

**Response**:
```json
{
  "user": {
    "id": 123,
    "username": "developer",
    "avatar_url": "https://...",
    "email": "user@example.com",
    "api_token": "finn_tok_..."
  },
  "packages": [...]
}
```

#### `POST /api/auth/logout`
Logs out the current user.

**Authentication**: Required

**Response**: Success confirmation.

#### `POST /api/auth/token/regenerate`
Generates a new API token for CLI usage.

**Authentication**: Required

**Response**:
```json
{
  "api_token": "finn_tok_new_token_here"
}
```

### Package Endpoints

#### `GET /api/packages`
Lists all published packages.

**Query Parameters**:
- `limit`: Number of results (default: 50)
- `offset`: Pagination offset (default: 0)

**Response**:
```json
{
  "packages": [
    {
      "name": "http",
      "description": "HTTP client library",
      "downloads": 1250,
      "owner_name": "developer"
    }
  ],
  "total": 150,
  "limit": 50,
  "offset": 0
}
```

#### `GET /api/packages/:name`
Retrieves detailed information about a specific package.

**Response**:
```json
{
  "name": "http",
  "description": "HTTP client library",
  "repo_url": "https://github.com/user/http",
  "homepage": "https://http-lib.dev",
  "keywords": ["http", "networking"],
  "license": "MIT",
  "downloads": 1250,
  "created_at": 1640995200,
  "updated_at": 1641081600,
  "owner_name": "developer",
  "versions": [
    {
      "version": "1.0.0",
      "commit_hash": "abc123",
      "created_at": 1641081600
    }
  ]
}
```

#### `POST /api/packages`
Creates a new package.

**Authentication**: Required

**Request Body**:
```json
{
  "name": "my-package",
  "description": "Package description",
  "repo_url": "https://github.com/user/my-package",
  "keywords": ["tag1", "tag2"],
  "license": "MIT",
  "homepage": "https://my-package.dev"
}
```

#### `POST /api/packages/:name/versions`
Publishes a new version of a package.

**Authentication**: Required (package owner only)

**Request Body**:
```json
{
  "version": "1.1.0",
  "commit_hash": "def456",
  "finn_toml_content": "[project]\nname = \"package\"\n...",
  "changelog": "Added new feature"
}
```

#### `DELETE /api/packages/:name`
Deletes a package.

**Authentication**: Required (package owner only)

### Search and Discovery

#### `GET /api/search`
Searches for packages by name or description.

**Query Parameters**:
- `q`: Search query string

**Response**:
```json
[
  {
    "name": "http-client",
    "description": "HTTP client implementation",
    "downloads": 850
  }
]
```

#### `GET /api/stats`
Retrieves registry-wide statistics.

**Response**:
```json
{
  "packages": 150,
  "users": 45,
  "downloads": 25000
}
```

### Documentation

#### `GET /api/packages/:name/readme`
Retrieves the README content for a package.

**Response**:
```json
{
  "readme": "# Package Name\n\nDescription..."
}
```

#### `GET /api/users/:username`
Retrieves public profile information for a user.

**Response**:
```json
{
  "id": 123,
  "username": "developer",
  "avatar_url": "https://...",
  "packages": [
    {
      "name": "http",
      "description": "HTTP library",
      "downloads": 1250
    }
  ]
}
```

## Package Manifest Format

Packages are defined using `finn.toml` manifest files:

```toml
[project]
name = "my_package"
version = "1.0.0"
entrypoint = "lib.fin"  # or "main.fin" for binaries
description = "A useful Fin package"
repository = "https://github.com/username/my_package"
license = "MIT"

[packages]
std = "std"        # Direct package reference
http = "http"      # Another package dependency
```

### Manifest Validation Rules

- **Name**: Lowercase alphanumeric with underscores/dashes
- **Version**: Semantic versioning (X.Y.Z)
- **Entrypoint**: Either `lib.fin` (library) or `main.fin` (executable)
- **Repository**: Valid GitHub repository URL
- **Dependencies**: Package names as keys, version constraints as values

## Finn Package Manager Integration

The registry integrates with the `finn` CLI tool:

1. **Package Discovery**: `finn search <query>` queries the registry API
2. **Package Installation**: `finn add <package>` downloads from registry
3. **Authentication**: API tokens link CLI to user accounts
4. **Publishing**: `finn publish` uploads packages to registry

## Architecture

- **Frontend**: React-based web interface for package browsing and management
- **Backend**: Cloudflare Workers API handling authentication and data operations
- **Database**: Cloudflare D1 for package metadata and user information
- **Storage**: GitHub repositories for package source code and documentation
- **Deployment**: Cloudflare Pages for frontend, Cloudflare Workers for API

## Contributing

The Finn Registry is an open-source project. Contributions are welcome for:

- UI/UX improvements
- API enhancements
- Documentation updates
- Bug fixes and feature requests

## License

MIT License
