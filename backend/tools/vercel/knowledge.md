# Vercel Platform Knowledge

## How Vercel Works

Vercel is a cloud platform for frontend deployment. It provides:
- Automatic builds from git pushes
- Preview deployments for pull requests
- Edge network for global CDN
- Serverless functions
- Environment variable management
- Custom domain configuration

## REST API

Full API for project lifecycle:
- Create project: `POST /v13/projects`
- Set env vars: `POST /v10/projects/{id}/env`
- Trigger deploy: git push to connected repo, or `POST /v13/deployments`
- Get deployments: `GET /v6/deployments`
- Get project: `GET /v9/projects/{id}`

Auth via Bearer token in Authorization header (auto-injected).

## Deploy Workflow

1. Create project via API (or connect to existing)
2. Set environment variables
3. Push code to connected git repo
4. Vercel auto-builds and deploys
5. Get deployment URL from API

## Git Integration

Projects can be connected to GitHub/GitLab/Bitbucket repos. Every push triggers a build:
- Push to main branch -> production deployment
- Push to other branches -> preview deployment
- Pull requests get preview URLs automatically
