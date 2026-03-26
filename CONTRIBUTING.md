# Contributing to Philharmonic

Thank you for your interest in contributing to Philharmonic! This guide will help you get started with contributing to the project.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Development Workflow](#development-workflow)
- [Code Style and Standards](#code-style-and-standards)
- [Testing](#testing)
- [Submitting Changes](#submitting-changes)
- [Pull Request Process](#pull-request-process)

## Code of Conduct

This project follows a standard code of conduct. Please be respectful and professional in all interactions.

## Getting Started

### Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** >= 20.0.0
- **pnpm** (`npm install -g pnpm`)
- **Git**
- A **Cloudflare account** (paid Workers plan required for Sandbox SDK)
- An **Anthropic API key** from [Anthropic Console](https://console.anthropic.com/)
- A **GitHub Personal Access Token** with repo scope

### Issues and Feature Requests

- Check existing issues before creating a new one
- Use the issue templates when available
- Provide clear and detailed descriptions
- Include steps to reproduce for bugs
- Tag issues appropriately

## Development Setup

1. **Fork and Clone**
   ```bash
   git clone https://github.com/YOUR_USERNAME/philharmonic.git
   cd philharmonic
   ```

2. **Install Dependencies**
   ```bash
   pnpm install
   ```

3. **Build the Project**
   ```bash
   pnpm build
   ```

4. **Set up Environment Variables** (for local development)
   ```bash
   cd packages/orchestrator
   # Create .dev.vars file with:
   ANTHROPIC_API_KEY=your_key_here
   GITHUB_TOKEN=your_token_here
   ```

5. **Run in Development Mode**
   ```bash
   # Terminal 1: Start the orchestrator
   cd packages/orchestrator
   npx wrangler dev
   
   # Terminal 2: Start the dashboard
   cd packages/dashboard
   pnpm dev
   ```

## Project Structure

This is a monorepo with the following structure:

```
philharmonic/
├── packages/
│   ├── shared/           # Shared types, schemas, and utilities
│   ├── orchestrator/     # Cloudflare Worker + Durable Object
│   ├── sandbox-runtime/  # Agent code for sandbox containers
│   └── dashboard/        # React SPA frontend
├── docker/
│   └── Dockerfile.sandbox # Container image for Sandbox SDK
├── package.json          # Root workspace configuration
└── tsconfig.base.json    # Base TypeScript configuration
```

### Package Descriptions

- **`@phil/shared`** - Common types, Zod schemas, tool definitions, and event protocol
- **`@phil/orchestrator`** - Main orchestration logic using Cloudflare Workers and Sandbox SDK
- **`@phil/sandbox-runtime`** - Claude-powered agent that runs inside sandbox containers
- **`@phil/dashboard`** - React frontend with real-time WebSocket streaming

## Development Workflow

### Branch Naming

Use descriptive branch names with prefixes:
- `feat/` - New features
- `fix/` - Bug fixes
- `docs/` - Documentation changes
- `refactor/` - Code refactoring
- `test/` - Adding or updating tests
- `chore/` - Maintenance tasks

Example: `feat/add-task-scheduling` or `fix/websocket-connection-issue`

### Making Changes

1. **Create a Feature Branch**
   ```bash
   git checkout -b feat/your-feature-name
   ```

2. **Make Your Changes**
   - Follow the existing code style and patterns
   - Write clear, concise commit messages
   - Keep changes focused and atomic

3. **Test Your Changes**
   ```bash
   # Type checking
   pnpm typecheck
   
   # Run tests (if available)
   pnpm test
   
   # Build to ensure no compilation errors
   pnpm build
   ```

## Code Style and Standards

### TypeScript

- Use TypeScript for all new code
- Follow the existing TypeScript configuration in `tsconfig.base.json`
- Use strict type checking
- Prefer explicit types over `any`
- Use meaningful variable and function names

### Code Formatting

- Use consistent indentation (2 spaces)
- Use semicolons
- Use single quotes for strings
- Follow existing patterns in the codebase

### File Organization

- Place types and interfaces in appropriate shared locations
- Keep files focused on a single responsibility
- Use barrel exports (`index.ts`) for cleaner imports
- Follow the existing directory structure

### Imports

- Use absolute imports from workspace packages (e.g., `@phil/shared`)
- Group imports: external packages first, then internal packages
- Sort imports alphabetically within groups

Example:
```typescript
import { nanoid } from 'nanoid';
import { Hono } from 'hono';

import { TaskSchema } from '@phil/shared';
import { createSandbox } from './sandbox.js';
```

## Testing

### Running Tests

```bash
# Run all tests
pnpm test

# Run tests for a specific package
pnpm --filter @phil/orchestrator test
```

### Writing Tests

- Write tests for new features and bug fixes
- Follow the existing testing patterns
- Use descriptive test names
- Include both positive and negative test cases
- Mock external dependencies appropriately

## Submitting Changes

### Commit Messages

Follow conventional commit format:

```
type(scope): brief description

Optional longer description explaining the change.

- List any breaking changes
- Reference issues with "Fixes #123" or "Closes #123"
```

Types:
- `feat`: A new feature
- `fix`: A bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

Examples:
```
feat(orchestrator): add task scheduling capability

Add ability to schedule tasks for future execution using
Durable Object alarms.

Fixes #42
```

```
fix(dashboard): resolve WebSocket reconnection issue

WebSocket connections now properly reconnect after
network interruptions with exponential backoff.

Closes #38
```

### Pre-commit Checklist

Before submitting a pull request:

- [ ] Code builds successfully (`pnpm build`)
- [ ] All type checks pass (`pnpm typecheck`)
- [ ] All tests pass (`pnpm test`)
- [ ] Code follows the existing style and patterns
- [ ] Commit messages are clear and follow conventions
- [ ] Documentation is updated if needed
- [ ] No sensitive information (API keys, tokens) is committed

## Pull Request Process

### Creating a Pull Request

1. **Push Your Branch**
   ```bash
   git push origin feat/your-feature-name
   ```

2. **Open a Pull Request**
   - Use a clear, descriptive title
   - Fill out the pull request template (if available)
   - Reference related issues
   - Describe the changes and their impact
   - Include screenshots for UI changes

### Pull Request Template

```markdown
## Description
Brief description of changes made.

## Type of Change
- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update

## Testing
- [ ] I have tested these changes locally
- [ ] I have added appropriate tests
- [ ] All tests pass

## Related Issues
Fixes #(issue number)
```

### Review Process

- All pull requests require at least one review
- Address reviewer feedback promptly
- Keep discussions constructive and focused
- Update your PR based on feedback
- Once approved, a maintainer will merge your PR

### After Your PR is Merged

- Delete your feature branch
- Pull the latest changes from main
- Consider contributing to documentation or helping with issues

## Getting Help

- **Documentation**: Check the README.md and inline code comments
- **Issues**: Search existing issues or create a new one
- **Discussions**: Use GitHub Discussions for questions and ideas

## Additional Resources

- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [Sandbox SDK Documentation](https://developers.cloudflare.com/sandbox/)
- [Anthropic API Documentation](https://docs.anthropic.com/)
- [Hono Framework Documentation](https://hono.dev/)

Thank you for contributing to Philharmonic! 🎼