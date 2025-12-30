# Finn Registry

The official package registry for the **Finn** package manager, serving the **Fin** programming language ecosystem. This application provides a centralized platform for publishing, discovering, and managing packages.

## Architecture and Technology Stack

The registry is built ensuring high performance, scalability, and maintainability.

*   **Framework**: Next.js (App Directory)
*   **Database**: SQLite with Cloudflare D1 (via Drizzle ORM)
*   **Styling**: Tailwind CSS
*   **Deployment**: Cloudflare Pages
*   **Runtime**: Bun / Node.js

## Getting Started

### Prerequisites

*   Node.js (v20 or later) or Bun
*   Git

### Installation

1.  Clone the repository:
    ```bash
    git clone <repository-url>
    cd finn-registry
    ```

2.  Install dependencies:
    ```bash
    npm install
    # or
    bun install
    ```

3.  Environment Configuration:
    Copy `.dev.vars.example` to `.dev.vars` (or `.env.local`) and configure the necessary environment variables.

4.  Start the development server:
    ```bash
    npm run dev
    ```

## Scripts

*   `npm run dev`: Starts the development server with Turbopack.
*   `npm run build`: Builds the application for production.
*   `npm run lint`: Runs ESLint for code quality checks.
*   `npm run typecheck`: Runs TypeScript compiler to check for type errors.
*   `npx drizzle-kit push`: Pushes schema changes to the database.

## Contributing

We welcome contributions to the Finn Registry. Please ensure that all new code adheres to the project's coding standards and passes all linting and type checks before submitting a Pull Request.
